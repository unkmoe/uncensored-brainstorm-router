/**
 * Governor state (persisted as JSON so day/month accruals survive restarts).
 *
 * Accrual model: each poll, the endpoint's instantaneous hourly rate
 * (Σ billable workers × catalog price) is integrated over the elapsed time
 * since the previous poll into session/day/month buckets (UTC keys).
 * Limits are evaluated per bucket; warn/breach/throttle flags fire once per
 * bucket to avoid log spam. Balance-API reflection is delayed (spend shows
 * up only after scale-down), so all buckets are estimate-based; the balance
 * floor is a separate guarantee.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface BucketState {
  key: string;
  accruedUsd: number;
  warned: boolean;
  breached: boolean;
  throttled: boolean;
}

export interface SessionState {
  active: boolean;
  /** ISO time the current session began (first billable worker observed). */
  startedAt: string | null;
  accruedUsd: number;
  warned: boolean;
  breached: boolean;
  throttled: boolean;
}

export interface EndpointState {
  session: SessionState;
  day: BucketState;
  month: BucketState;
  /** workers.min/max saved before a throttle PATCH, for --restore. */
  originalWorkers: { min: number; max: number } | null;
}

export type GovernorState = Record<string, EndpointState>;

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function utcMonthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function emptyEndpointState(nowMs: number): EndpointState {
  return {
    session: { active: false, startedAt: null, accruedUsd: 0, warned: false, breached: false, throttled: false },
    day: { key: utcDayKey(nowMs), accruedUsd: 0, warned: false, breached: false, throttled: false },
    month: { key: utcMonthKey(nowMs), accruedUsd: 0, warned: false, breached: false, throttled: false },
    originalWorkers: null,
  };
}

export function loadState(filePath: string): GovernorState {
  if (!existsSync(filePath)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as GovernorState;
  } catch {
    return {};
  }
}

export function getState(state: GovernorState, endpointId: string, nowMs: number): EndpointState {
  let st = state[endpointId];
  if (!st) {
    st = emptyEndpointState(nowMs);
    state[endpointId] = st;
  }
  const fresh = emptyEndpointState(nowMs);
  if (st.day.key !== fresh.day.key) {
    state[endpointId] = st = { ...st, day: fresh.day };
  }
  if (st.month.key !== fresh.month.key) {
    state[endpointId] = st = { ...st, month: fresh.month };
  }
  return st;
}

/** Atomic-ish save: write to tmp then rename. */
export function saveState(filePath: string, state: GovernorState): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  renameSync(tmp, filePath);
}
