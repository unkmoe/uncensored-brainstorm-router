/**
 * Throttle action: PATCH /v2/serverless/{id} with { workers: { max: 0 } }.
 *
 * Safety (verified against the OpenAPI spec, UpdateEndpointRequest):
 * - PATCH is a partial update: "Only provided fields are changed." Sending
 *   only workers.max touches nothing else (image, env, gpu pools, scaling,
 *   idleTimeout, ... all stay as-is).
 * - workers.max accepts 0 (minimum 0); with min 0 the endpoint scales to zero
 *   and stops launching new workers. There is no delete semantics on this
 *   PATCH — it cannot remove the endpoint.
 * - If the endpoint currently has workers.min > 0, max: 0 alone would be an
 *   invalid or contradictory range, so min is set to 0 in the same PATCH and
 *   the original pair is saved for --restore.
 * - Only invoked when the CLI runs with --apply; before PATCHing, the current
 *   values are re-read (read-then-write) and verified afterwards.
 */

import type { RunPodClient } from '../client.js';
import type { JsonlLogger } from './jsonl.js';
import type { GovernorState, getState } from './state.js';

interface EndpointWorkersView {
  min: number;
  max: number;
}

async function readWorkers(client: RunPodClient, id: string): Promise<EndpointWorkersView> {
  const res = await client.get('/v2/serverless/{id}', { path: { id } });
  const workers = (res.data as { workers?: { min?: unknown; max?: unknown } }).workers;
  const min = typeof workers?.['min'] === 'number' ? workers['min'] : 0;
  const max = typeof workers?.['max'] === 'number' ? workers['max'] : 0;
  return { min, max };
}

/**
 * Scale the endpoint to zero (workers.max = 0). Idempotent. Returns true when
 * the endpoint is confirmed throttled.
 */
export async function throttleEndpoint(
  client: RunPodClient,
  id: string,
  state: GovernorState,
  getStateFn: typeof getState,
  logger: JsonlLogger,
  cause: string,
): Promise<boolean> {
  const nowMs = Date.now();
  const st = getStateFn(state, id, nowMs);

  const current = await readWorkers(client, id);
  if (current.max === 0) {
    logger.info('throttle_already', { endpoint: id, cause, workers: current });
    st.originalWorkers = st.originalWorkers ?? (current.min > 0 ? current : null);
    return true;
  }

  st.originalWorkers = { min: current.min, max: current.max };
  const body = current.min > 0 ? { workers: { min: 0, max: 0 } } : { workers: { max: 0 } };
  logger.warn('throttle_apply', { endpoint: id, cause, body, previousWorkers: current });

  await client.patch('/v2/serverless/{id}', { path: { id }, body });

  // Verify with a fresh GET.
  const after = await readWorkers(client, id);
  const ok = after.max === 0;
  logger.log(ok ? 'warn' : 'error', 'throttle_verify', { endpoint: id, verified: ok, workersAfter: after });
  return ok;
}

/** Restore the pre-throttle workers.min/max (also a PATCH; --apply only). */
export async function restoreEndpoint(
  client: RunPodClient,
  id: string,
  state: GovernorState,
  getStateFn: typeof getState,
  logger: JsonlLogger,
): Promise<void> {
  const nowMs = Date.now();
  const st = getStateFn(state, id, nowMs);
  if (!st.originalWorkers) {
    logger.warn('restore_no_saved', { endpoint: id });
    return;
  }
  const saved = st.originalWorkers;
  logger.warn('restore_apply', { endpoint: id, body: { workers: saved } });
  await client.patch('/v2/serverless/{id}', { path: { id }, body: { workers: saved } });
  const after = await readWorkers(client, id);
  logger.info('restore_verify', { endpoint: id, workersAfter: after });
  st.originalWorkers = null;
}
