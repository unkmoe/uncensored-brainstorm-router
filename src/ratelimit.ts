/**
 * Parsing for RunPod's ratelimit-headers (IETF draft style):
 *
 *   RateLimit:        "minute";r=0;t=12, "hour";r=2800;t=1812, "day";r=49500;t=45012
 *   RateLimit-Policy: "minute";q=180;w=60, "hour";q=3600;w=3600, "day";q=43200;w=86400
 *
 * The header is optional (omitted for rate-limit-exempt callers) and is returned
 * on responses to authenticated requests, not only on 429s.
 */

export interface RateLimitWindowState {
  /** Remaining requests in this window. */
  r: number;
  /** Seconds until the (clock-aligned) window resets. */
  t: number;
}

export interface RateLimitPolicyWindowState {
  /** Quota for this window. */
  q: number;
  /** Window length in seconds. */
  w: number;
}

export type RateLimitState = Partial<Record<'minute' | 'hour' | 'day', RateLimitWindowState>> & {
  [window: string]: RateLimitWindowState | undefined;
};

export type RateLimitPolicy = Partial<Record<'minute' | 'hour' | 'day', RateLimitPolicyWindowState>> & {
  [window: string]: RateLimitPolicyWindowState | undefined;
};

/** Extract an integer from a structured-field member's parameters. */
function intParam(params: Map<string, string | number | boolean | undefined>, key: string): number | undefined {
  const v = params.get(key);
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * Parse a structured-field list such as `"minute";r=0;t=12, "hour";r=2800;t=1812`.
 * Tolerant of whitespace and trailing separators; returns a plain object on
 * success and `null` when the header is absent or unparsable.
 */
export function parseRateLimitHeader(raw: string | null | undefined): RateLimitState | null {
  if (!raw) return null;
  const out: RateLimitState = {};
  for (const member of raw.split(',')) {
    const m = member.match(/^\s*(?:")([^"]+)(?:")\s*;(.*)$/);
    if (!m) continue;
    const [, window, rest] = m as [string, string, string];
    const params = new Map<string, string | number>();
    for (const pair of rest.split(';')) {
      const kv = pair.split('=', 2);
      if (kv.length !== 2) continue;
      const value = kv[1]!.trim().replace(/^"|"$/g, '');
      params.set(kv[0]!.trim(), /^\d+$/.test(value) ? Number(value) : value);
    }
    const r = intParam(params as Map<string, string | number | undefined>, 'r');
    const t = intParam(params as Map<string, string | number | undefined>, 't');
    if (r === undefined || t === undefined) continue;
    out[window] = { r, t };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse `"minute";q=180;w=60, ...` (the static policy header). */
export function parseRateLimitPolicyHeader(raw: string | null | undefined): RateLimitPolicy | null {
  if (!raw) return null;
  const out: RateLimitPolicy = {};
  for (const member of raw.split(',')) {
    const m = member.match(/^\s*(?:")([^"]+)(?:")\s*;(.*)$/);
    if (!m) continue;
    const [, window, rest] = m as [string, string, string];
    const params = new Map<string, string | number>();
    for (const pair of rest.split(';')) {
      const kv = pair.split('=', 2);
      if (kv.length !== 2) continue;
      const value = kv[1]!.trim().replace(/^"|"$/g, '');
      params.set(kv[0]!.trim(), /^\d+$/.test(value) ? Number(value) : value);
    }
    const q = intParam(params as Map<string, string | number | undefined>, 'q');
    const w = intParam(params as Map<string, string | number | undefined>, 'w');
    if (q === undefined || w === undefined) continue;
    out[window] = { q, w };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Human-readable one-liner, e.g. `minute r=0 t=12s; hour r=2800 t=1812s`. */
export function formatRateLimit(state: RateLimitState | null): string {
  if (!state) return '(no RateLimit header)';
  return Object.entries(state)
    .map(([w, v]) => `${w} r=${v!.r} t=${v!.t}s`)
    .join('; ');
}
