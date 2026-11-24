/**
 * runpod-client — thin fetch-based client for the RunPod REST API v2
 * (https://api.runpod.io/v2).
 *
 * Design goals:
 * - minimal dependencies (global fetch only)
 * - `Authorization: Bearer` auth
 * - 429: honor `Retry-After` (+ jitter). The RunPod docs state a 429 only
 *   slows the caller down and the request was NOT processed, so retrying any
 *   method after the wait is safe; still configurable via `retry429`.
 * - 5xx: exponential backoff with jitter, auto-retried for GET only
 *   (POST/PATCH/DELETE are never auto-retried to avoid duplicate resources).
 * - `RateLimit` / `RateLimit-Policy` headers are parsed and exposed on every
 *   result so callers can adapt their polling pace.
 * - Typed request/response via openapi-typescript output (src/generated/schema.ts).
 */

import type { paths } from './generated/schema.js';
import {
  type RateLimitPolicy,
  type RateLimitState,
  formatRateLimit,
  parseRateLimitHeader,
  parseRateLimitPolicyHeader,
} from './ratelimit.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type PathKey = keyof paths;

/** The generated operations object for a path+method (never for invalid combos). */
type Op<P extends PathKey, M extends HttpMethod> = paths[P][M] extends { responses: unknown }
  ? paths[P][M]
  : never;

/** 200 JSON body type of a path+method. */
export type SuccessJson<P extends PathKey, M extends HttpMethod> =
  Op<P, M> extends { responses: { 200: { content: { 'application/json': infer D } } } } ? D : never;

/** Query parameter type of a path+method. */
export type QueryOf<P extends PathKey, M extends HttpMethod> =
  Op<P, M> extends { parameters: { query?: infer Q } } ? (Q extends Record<string, unknown> ? Q : undefined) : undefined;

/** Path parameter type of a path+method. */
export type PathParamsOf<P extends PathKey, M extends HttpMethod> =
  Op<P, M> extends { parameters: { path?: infer Pa } } ? (Pa extends Record<string, string> ? Pa : undefined) : undefined;

/** JSON request body type of a path+method (undefined when the op takes no body). */
export type BodyOf<P extends PathKey, M extends HttpMethod> =
  Op<P, M> extends { requestBody?: { content: { 'application/json': infer B } } } ? B : undefined;

export interface RunpodResult<T> {
  /** HTTP status (2xx). */
  status: number;
  /** Parsed JSON body. */
  data: T;
  /** Parsed `RateLimit` header (live per-window remaining), or null. */
  rateLimit: RateLimitState | null;
  /** Parsed `RateLimit-Policy` header (static quota), or null. */
  rateLimitPolicy: RateLimitPolicy | null;
  /** Raw response headers, for anything not covered above. */
  headers: Headers;
}

export class RunPodApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly rateLimit: RateLimitState | null;
  readonly rateLimitPolicy: RateLimitPolicy | null;

  constructor(init: {
    status: number;
    method: string;
    url: string;
    body: unknown;
    rateLimit: RateLimitState | null;
    rateLimitPolicy: RateLimitPolicy | null;
  }) {
    super(`RunPod API ${init.method} ${init.url} -> ${init.status}: ${summarizeBody(init.body)}`);
    this.name = 'RunPodApiError';
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.body = init.body;
    this.rateLimit = init.rateLimit;
    this.rateLimitPolicy = init.rateLimitPolicy;
  }
}

function summarizeBody(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  if (s === undefined) return '(no body)';
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

export interface RunPodClientOptions {
  /** RunPod API key. Defaults to `process.env.RUNPOD_API_KEY`. */
  apiKey?: string;
  /** Base URL. Defaults to `https://api.runpod.io/v2`. */
  baseUrl?: string;
  /** Injectable fetch (for tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Max number of retries (after the initial attempt). Default 4. */
  maxRetries?: number;
  /** Auto-retry 429 after Retry-After? Default true (safe for any method). */
  retry429?: boolean;
  /** Auto-retry 5xx (GET only)? Default true. */
  retry5xx?: boolean;
  /** Backoff base in ms for 5xx. Default 1_000. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. Default 20_000. */
  backoffMaxMs?: number;
  /** Relative jitter applied to every wait (±). Default 0.2. */
  jitterRatio?: number;
  /** Sleep injection for tests. Default ms-based setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  // Path templates already carry the /v2 prefix, so the base is the host root.
  baseUrl: 'https://api.runpod.io',
  timeoutMs: 30_000,
  maxRetries: 4,
  retry429: true,
  retry5xx: true,
  backoffBaseMs: 1_000,
  backoffMaxMs: 20_000,
  jitterRatio: 0.2,
};

export interface RequestOptions<P extends PathKey, M extends HttpMethod> {
  query?: QueryOf<P, M> | undefined;
  path?: PathParamsOf<P, M> | undefined;
  body?: BodyOf<P, M> | undefined;
  /** Skip the built-in retry logic entirely. */
  noRetry?: boolean;
}

export class RunPodClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: Required<
    Pick<
      RunPodClientOptions,
      'timeoutMs' | 'maxRetries' | 'retry429' | 'retry5xx' | 'backoffBaseMs' | 'backoffMaxMs' | 'jitterRatio'
    >
  >;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RunPodClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env['RUNPOD_API_KEY'];
    if (!apiKey) throw new Error('RunPod API key missing: pass options.apiKey or set RUNPOD_API_KEY');
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.opts = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      retry429: options.retry429 ?? DEFAULTS.retry429,
      retry5xx: options.retry5xx ?? DEFAULTS.retry5xx,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
      jitterRatio: options.jitterRatio ?? DEFAULTS.jitterRatio,
    };
    this.sleep = options.sleep ?? defaultSleep;
  }

  // ------------------------------------------------------------------ core

  async request<P extends PathKey, M extends HttpMethod>(
    method: M,
    path: P,
    options: RequestOptions<P, M> = {},
  ): Promise<RunpodResult<SuccessJson<P, M>>> {
    const url = this.buildUrl(path, options);
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (cause) {
        // Network error / timeout: retryable for GET, same rationale as 5xx.
        if (attempt < this.opts.maxRetries && method === 'get' && !options.noRetry && this.opts.retry5xx) {
          await this.wait(this.backoffMs(attempt));
          continue;
        }
        throw new RunPodApiError({
          status: 0,
          method: method.toUpperCase(),
          url,
          body: cause instanceof Error ? cause.message : String(cause),
          rateLimit: null,
          rateLimitPolicy: null,
        });
      }

      const rateLimit = parseRateLimitHeader(res.headers.get('RateLimit'));
      const rateLimitPolicy = parseRateLimitPolicyHeader(res.headers.get('RateLimit-Policy'));

      if (res.status === 429 && this.opts.retry429 && attempt < this.opts.maxRetries && !options.noRetry) {
        await this.wait(this.retryAfterMs(res, attempt));
        continue;
      }
      // (429 handling: the request was rate-limited, not processed — safe to retry any method.)

      if (res.status >= 500 && method === 'get' && this.opts.retry5xx && attempt < this.opts.maxRetries && !options.noRetry) {
        await this.wait(this.backoffMs(attempt));
        continue;
      }

      const text = await res.text();
      const body: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

      if (!res.ok) {
        throw new RunPodApiError({
          status: res.status,
          method: method.toUpperCase(),
          url,
          body,
          rateLimit,
          rateLimitPolicy,
        });
      }

      return { status: res.status, data: body as SuccessJson<P, M>, rateLimit, rateLimitPolicy, headers: res.headers };
    }
  }

  /** Typed GET. Auto-retries on 429/5xx/network errors. */
  get<P extends PathKey>(path: P, options?: RequestOptions<P, 'get'>) {
    return this.request('get', path, options);
  }

  /** Typed POST. Never auto-retried (duplicate-resource risk). */
  post<P extends PathKey>(path: P, options?: RequestOptions<P, 'post'>) {
    return this.request('post', path, options);
  }

  /** Typed PATCH. Never auto-retried. */
  patch<P extends PathKey>(path: P, options?: RequestOptions<P, 'patch'>) {
    return this.request('patch', path, options);
  }

  /** Typed PUT. Never auto-retried. */
  put<P extends PathKey>(path: P, options?: RequestOptions<P, 'put'>) {
    return this.request('put', path, options);
  }

  /** Typed DELETE. Never auto-retried. */
  delete<P extends PathKey>(path: P, options?: RequestOptions<P, 'delete'>) {
    return this.request('delete', path, options);
  }

  // ------------------------------------------------------- read-only sugar

  /** GET /v2/billing/balance — account balance. */
  getBalance() {
    return this.get('/v2/billing/balance');
  }

  /** GET /v2/billing — aggregated billing history. */
  listBilling(query?: QueryOf<'/v2/billing', 'get'>) {
    return this.get('/v2/billing', { query });
  }

  /** GET /v2/billing/pods — per-pod billing history. */
  getPodBilling(query?: QueryOf<'/v2/billing/pods', 'get'>) {
    return this.get('/v2/billing/pods', { query });
  }

  /** GET /v2/billing/serverless — per-endpoint billing history. */
  getServerlessBilling(query?: QueryOf<'/v2/billing/serverless', 'get'>) {
    return this.get('/v2/billing/serverless', { query });
  }

  /** GET /v2/catalog/gpus — GPU catalog (pass include=AVAILABILITY + product for stock). */
  listGpus(query?: QueryOf<'/v2/catalog/gpus', 'get'>) {
    return this.get('/v2/catalog/gpus', { query });
  }

  /** GET /v2/catalog/gpus/{id} — single GPU type. */
  getGpu(id: string, query?: QueryOf<'/v2/catalog/gpus/{id}', 'get'>) {
    return this.get('/v2/catalog/gpus/{id}', { path: { id } as PathParamsOf<'/v2/catalog/gpus/{id}', 'get'>, query });
  }

  /** GET /v2/catalog/cpus — CPU instance catalog. */
  listCpus(query?: QueryOf<'/v2/catalog/cpus', 'get'>) {
    return this.get('/v2/catalog/cpus', { query });
  }

  /** GET /v2/catalog/datacenters — data centers (+ availability). */
  listDatacenters(query?: QueryOf<'/v2/catalog/datacenters', 'get'>) {
    return this.get('/v2/catalog/datacenters', { query });
  }

  /** GET /v2/pods — list pods. */
  listPods(query?: QueryOf<'/v2/pods', 'get'>) {
    return this.get('/v2/pods', { query });
  }

  /** GET /v2/pods/{id} — one pod (includes `cost` and `runtime.uptime`). */
  getPod(id: string) {
    return this.get('/v2/pods/{id}', { path: { id } as PathParamsOf<'/v2/pods/{id}', 'get'> });
  }

  /** GET /v2/queued-pods — queued pod requests. */
  listQueuedPods(query?: QueryOf<'/v2/queued-pods', 'get'>) {
    return this.get('/v2/queued-pods', { query });
  }

  /** GET /v2/serverless — list serverless endpoints. */
  listServerless(query?: QueryOf<'/v2/serverless', 'get'>) {
    return this.get('/v2/serverless', { query });
  }

  /** GET /v2/serverless/{id} — one serverless endpoint. */
  getServerless(id: string) {
    return this.get('/v2/serverless/{id}', { path: { id } as PathParamsOf<'/v2/serverless/{id}', 'get'> });
  }

  /** GET /v2/serverless/{id}/workers — workers of an endpoint. */
  getServerlessWorkers(id: string, query?: QueryOf<'/v2/serverless/{id}/workers', 'get'>) {
    return this.get('/v2/serverless/{id}/workers', {
      path: { id } as PathParamsOf<'/v2/serverless/{id}/workers', 'get'>,
      query,
    });
  }

  /** GET /v2/serverless/{id}/builds — build history of an endpoint. */
  getServerlessBuilds(id: string, query?: QueryOf<'/v2/serverless/{id}/builds', 'get'>) {
    return this.get('/v2/serverless/{id}/builds', {
      path: { id } as PathParamsOf<'/v2/serverless/{id}/builds', 'get'>,
      query,
    });
  }

  /** GET /v2/templates — container templates. */
  listTemplates(query?: QueryOf<'/v2/templates', 'get'>) {
    return this.get('/v2/templates', { query });
  }

  /** GET /v2/account — authenticated account. */
  getAccount() {
    return this.get('/v2/account');
  }

  /** GET /v2/account/limits — account limits (e.g. spend limit). */
  getAccountLimits() {
    return this.get('/v2/account/limits');
  }

  // -------------------------------------------------------------- internal

  private buildUrl<P extends PathKey, M extends HttpMethod>(path: P, options: RequestOptions<P, M>): string {
    let p: string = path;
    if (options.path) {
      for (const [key, value] of Object.entries(options.path as Record<string, string>)) {
        p = p.replaceAll(`{${key}}`, encodeURIComponent(value));
      }
    }
    const query = options.query as Record<string, unknown> | undefined;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length > 0) search.set(key, value.join(','));
      } else if (typeof value === 'boolean') {
        search.set(key, String(value));
      } else {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    return `${this.baseUrl}${p}${qs ? `?${qs}` : ''}`;
  }

  /** Retry-After based wait with jitter; falls back to exponential backoff. */
  private retryAfterMs(res: Response, attempt: number): number {
    const ra = res.headers.get('Retry-After');
    let base = 0;
    if (ra) {
      const seconds = Number(ra);
      if (Number.isFinite(seconds) && seconds >= 0) {
        base = Math.min(seconds * 1_000, this.opts.backoffMaxMs);
      } else {
        const date = Date.parse(ra);
        if (Number.isFinite(date)) base = Math.max(0, Math.min(date - Date.now(), this.opts.backoffMaxMs));
      }
    }
    if (base === 0) base = this.backoffMs(attempt);
    return this.jitter(base);
  }
  // retryAfterMs is sync: jitter/backoff are pure computations.

  /** Exponential backoff: base * 2^attempt, capped. */
  private backoffMs(attempt: number): number {
    return Math.min(this.opts.backoffBaseMs * 2 ** attempt, this.opts.backoffMaxMs);
  }

  private async wait(ms: number): Promise<void> {
    await this.sleep(ms);
  }

  private jitter(ms: number): number {
    const { jitterRatio } = this.opts;
    const delta = ms * jitterRatio * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(ms + delta));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export { formatRateLimit };
