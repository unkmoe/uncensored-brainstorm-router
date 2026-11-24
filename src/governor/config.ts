/**
 * Budget governor configuration (JSON).
 *
 * Shape (see governor.config.example.json):
 * {
 *   "pollIntervalSeconds": 30,
 *   "warnRatio": 0.8,
 *   "balanceFloorUsd": 5.0,
 *   "balanceFloorAction": "warn" | "throttle",
 *   "autoDiscover": true,
 *   "maxSessionBackfillSeconds": 3600,
 *   "catalogRefreshSeconds": 600,
 *   "logFile": "governor.log.jsonl",
 *   "stateFile": "governor-state.json",
 *   "defaultLimits": { "sessionUsd": 2, "dayUsd": 10, "monthUsd": 50 },
 *   "endpoints": [
 *     { "id": "<endpointId>", "name": "your-endpoint", "limits": { "sessionUsd": 1 } }
 *   ]
 * }
 *
 * Default mode is warn-only ("dry-run"): thresholds only emit log events.
 * The throttle PATCH is sent only when the CLI runs with --apply.
 */

import { readFileSync } from 'node:fs';

export interface EndpointLimits {
  /** Per-session cap (USD). A session = continuous span while the endpoint has billable workers. */
  sessionUsd?: number;
  /** Per-UTC-day cap (USD), accrued from governor estimates. */
  dayUsd?: number;
  /** Per-UTC-month cap (USD), accrued from governor estimates. */
  monthUsd?: number;
}

export interface EndpointConfig {
  id: string;
  name?: string;
  limits: EndpointLimits;
}

export interface GovernorConfig {
  pollIntervalSeconds: number;
  /** Warn at warnRatio × limit. Breach (and throttle, with --apply) at 1.0 × limit. */
  warnRatio: number;
  /** GET /v2/billing/balance floor (USD). Note: the balance API reflects spend only after scale-down, so this is a conservative floor guarantee. */
  balanceFloorUsd?: number;
  balanceFloorAction: 'warn' | 'throttle';
  /** Also monitor endpoints not listed in `endpoints` (limits: defaultLimits). */
  autoDiscover: boolean;
  /** When a new session starts, backfill accrual up to this many seconds before now. */
  maxSessionBackfillSeconds: number;
  /** How often to re-fetch the GPU catalog for serverless prices. */
  catalogRefreshSeconds: number;
  logFile: string | null;
  stateFile: string;
  defaultLimits: EndpointLimits;
  endpoints: EndpointConfig[];
}

const DEFAULTS = {
  pollIntervalSeconds: 30,
  warnRatio: 0.8,
  balanceFloorAction: 'warn' as const,
  autoDiscover: false,
  maxSessionBackfillSeconds: 3600,
  catalogRefreshSeconds: 600,
  stateFile: 'governor-state.json',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asPositiveNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`config: ${what} must be a positive number (got ${JSON.stringify(v)})`);
  }
  return v;
}

function parseLimits(v: unknown, what: string): EndpointLimits {
  if (v === undefined) return {};
  if (!isRecord(v)) throw new Error(`config: ${what} must be an object`);
  const out: EndpointLimits = {};
  for (const key of ['sessionUsd', 'dayUsd', 'monthUsd'] as const) {
    const raw = v[key];
    if (raw === undefined) continue;
    out[key] = asPositiveNumber(raw, `${what}.${key}`);
  }
  const unknown = Object.keys(v).filter((k) => !['sessionUsd', 'dayUsd', 'monthUsd'].includes(k));
  if (unknown.length > 0) throw new Error(`config: ${what} has unknown keys: ${unknown.join(', ')}`);
  return out;
}

export function loadConfig(path: string): GovernorConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error('config: root must be a JSON object');

  const pollIntervalSeconds =
    raw['pollIntervalSeconds'] === undefined
      ? DEFAULTS.pollIntervalSeconds
      : asPositiveNumber(raw['pollIntervalSeconds'], 'pollIntervalSeconds');
  if (pollIntervalSeconds < 5 || pollIntervalSeconds > 600) {
    throw new Error('config: pollIntervalSeconds must be between 5 and 600');
  }

  const warnRatio =
    raw['warnRatio'] === undefined ? DEFAULTS.warnRatio : asPositiveNumber(raw['warnRatio'], 'warnRatio');
  if (warnRatio > 1) throw new Error('config: warnRatio must be <= 1');

  const balanceFloorActionRaw = raw['balanceFloorAction'];
  if (balanceFloorActionRaw !== undefined && balanceFloorActionRaw !== 'warn' && balanceFloorActionRaw !== 'throttle') {
    throw new Error("config: balanceFloorAction must be 'warn' or 'throttle'");
  }

  const endpointsRaw = raw['endpoints'];
  if (endpointsRaw !== undefined && !Array.isArray(endpointsRaw)) {
    throw new Error('config: endpoints must be an array');
  }
  const endpoints: EndpointConfig[] = [];
  const seen = new Set<string>();
  for (const [i, e] of (endpointsRaw ?? []).entries()) {
    if (!isRecord(e) || typeof e['id'] !== 'string' || e['id'].length === 0) {
      throw new Error(`config: endpoints[${i}].id must be a non-empty string`);
    }
    if (seen.has(e['id'])) throw new Error(`config: duplicate endpoint id ${e['id']}`);
    seen.add(e['id']);
    const cfg: EndpointConfig = { id: e['id'], limits: parseLimits(e['limits'], `endpoints[${i}].limits`) };
    if (typeof e['name'] === 'string') cfg.name = e['name'];
    endpoints.push(cfg);
  }

  const cfg: GovernorConfig = {
    pollIntervalSeconds,
    warnRatio,
    balanceFloorAction: balanceFloorActionRaw === 'throttle' ? 'throttle' : DEFAULTS.balanceFloorAction,
    autoDiscover: raw['autoDiscover'] === true,
    maxSessionBackfillSeconds:
      raw['maxSessionBackfillSeconds'] === undefined
        ? DEFAULTS.maxSessionBackfillSeconds
        : asPositiveNumber(raw['maxSessionBackfillSeconds'], 'maxSessionBackfillSeconds'),
    catalogRefreshSeconds:
      raw['catalogRefreshSeconds'] === undefined
        ? DEFAULTS.catalogRefreshSeconds
        : asPositiveNumber(raw['catalogRefreshSeconds'], 'catalogRefreshSeconds'),
    stateFile:
      typeof raw['stateFile'] === 'string' ? raw['stateFile'] : DEFAULTS.stateFile,
    logFile: typeof raw['logFile'] === 'string' ? raw['logFile'] : null,
    defaultLimits: parseLimits(raw['defaultLimits'], 'defaultLimits'),
    endpoints,
  };

  if (typeof raw['balanceFloorUsd'] === 'number' && Number.isFinite(raw['balanceFloorUsd']) && raw['balanceFloorUsd'] >= 0) {
    cfg.balanceFloorUsd = raw['balanceFloorUsd'];
  } else if (raw['balanceFloorUsd'] !== undefined) {
    throw new Error('config: balanceFloorUsd must be a non-negative number');
  }
  if (raw['logFile'] !== undefined && raw['logFile'] !== null && typeof raw['logFile'] !== 'string') {
    throw new Error('config: logFile must be a string or null');
  }

  return cfg;
}
