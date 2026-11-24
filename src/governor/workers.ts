/**
 * Billable-worker detection for serverless endpoints.
 *
 * The workers list (GET /v2/serverless/{id}/workers) mixes real workers with
 * stale placeholder records (doc/04 §7, phase1-deploy.md §2d): e.g. 3 records
 * shown while only 1 worker was actually billed. Discrimination signals,
 * verified against the live API (2026-11-23):
 *
 * - `uptimeSeconds` is null until a worker is actually placed and running.
 *   Stale placeholders carry startedAt/DC/GPU but never a live uptime, and
 *   typically surface as THROTTLED (or IDLE) with hours-old startedAt.
 * - For RUNNING/IDLE workers the uptime must be self-consistent:
 *   startedAt + uptimeSeconds ≈ now (slack for API/reporting delay).
 * - A real worker's uptime grows between polls; two consecutive identical
 *   nonzero uptimes identify a frozen (phantom) record.
 * - INITIALIZING workers may legitimately have null uptimeSeconds (not yet
 *   ready); they are billable only while startedAt is fresher than the
 *   endpoint's initTimeout.
 * - THROTTLED means "waiting on compute capacity" (no pod allocated) → not billed.
 * - UNHEALTHY keeps a pod allocated → billed only with live uptime evidence.
 */

export interface WorkerView {
  id: string;
  status: string;
  startedAt: string | null;
  uptimeSeconds: number | null;
  gpuTypeId: string | null;
  gpuCount: number;
  dataCenterId: string | null;
}

export interface RejectedWorker {
  worker: WorkerView;
  reason: string;
}

export interface Classification {
  billable: WorkerView[];
  rejected: RejectedWorker[];
  /** true if any worker was rejected due to a suspicious (frozen-uptime) record. */
  phantomSeen: boolean;
}

interface TrackerEntry {
  lastUptime: number | null;
  stagnantPolls: number;
}

export type WorkerTracker = Map<string, TrackerEntry>;

/** Slack for |now - (startedAt + uptimeSeconds)|, covering API/reporting delay. */
const UPTIME_CONSISTENCY_SLACK_SECONDS = 600;
/** Consecutive polls with identical nonzero uptime before a record is a phantom. */
const STAGNANT_POLL_LIMIT = 2;

export function classifyWorkers(
  workers: WorkerView[],
  nowMs: number,
  initTimeoutSeconds: number,
  tracker: WorkerTracker,
): Classification {
  const billable: WorkerView[] = [];
  const rejected: RejectedWorker[] = [];
  let phantomSeen = false;
  const seen = new Set<string>();

  for (const w of workers) {
    seen.add(w.id);
    const prev = tracker.get(w.id);
    const verdict = judge(w, nowMs, initTimeoutSeconds, prev);
    if (verdict === null) {
      billable.push(w);
      continue;
    }
    if (verdict === 'stagnant-uptime') phantomSeen = true;
    rejected.push({ worker: w, reason: verdict });
  }

  // Advance the tracker for every seen worker.
  for (const w of workers) {
    const uptime = w.uptimeSeconds;
    const prev = tracker.get(w.id);
    let stagnant = 0;
    if (uptime !== null && uptime > 0 && prev && prev.lastUptime !== null && prev.lastUptime === uptime) {
      stagnant = prev.stagnantPolls + 1;
    }
    tracker.set(w.id, { lastUptime: uptime, stagnantPolls: stagnant });
  }
  // Forget workers that disappeared (their records are gone; restart tracking cleanly).
  for (const id of [...tracker.keys()]) {
    if (!seen.has(id)) tracker.delete(id);
  }

  return { billable, rejected, phantomSeen };
}

/** null = billable, otherwise the rejection reason. */
function judge(
  w: WorkerView,
  nowMs: number,
  initTimeoutSeconds: number,
  prev: TrackerEntry | undefined,
): string | null {
  // Placement evidence: a billable worker must sit on an allocated GPU.
  if (!w.gpuTypeId || w.gpuCount < 1 || !w.dataCenterId) return 'no-placement';

  if (w.status === 'THROTTLED') return 'throttled-no-pod';

  if (w.status === 'RUNNING' || w.status === 'IDLE' || w.status === 'UNHEALTHY') {
    // Live uptime is the primary signal; stale placeholders never have it.
    if (w.uptimeSeconds === null) return 'no-live-uptime';
    if (prev && prev.stagnantPolls >= STAGNANT_POLL_LIMIT) return 'stagnant-uptime';
    if (w.startedAt) {
      const startMs = Date.parse(w.startedAt);
      if (Number.isFinite(startMs)) {
        const implied = startMs + w.uptimeSeconds * 1000;
        const drift = Math.abs(nowMs - implied) / 1000;
        if (drift > UPTIME_CONSISTENCY_SLACK_SECONDS) return 'uptime-inconsistent';
      }
    }
    return null;
  }

  if (w.status === 'INITIALIZING') {
    // Billable while the init window is open; uptime may legitimately be null.
    if (!w.startedAt) return 'initializing-no-startedat';
    const startMs = Date.parse(w.startedAt);
    if (!Number.isFinite(startMs)) return 'initializing-bad-startedat';
    if (nowMs - startMs > initTimeoutSeconds * 1000) return 'initializing-expired';
    return null;
  }

  return `unknown-status:${w.status}`;
}
