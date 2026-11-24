/**
 * Budget governor main loop.
 *
 * Per poll (default 30 s), for each monitored endpoint:
 *  1. GET /v2/serverless/{id}/workers → classify billable workers
 *     (see workers.ts; placeholder IDLE/THROTTLED records are rejected).
 *  2. Rate = Σ billable workers × catalog serverless price (USD/hour).
 *  3. Integrate rate over the elapsed poll interval into session/day/month
 *     buckets (UTC keys, persisted in the state file).
 *  4. Evaluate per-endpoint limits (sessionUsd/dayUsd/monthUsd):
 *     warn at warnRatio × limit; breach at limit. Breach throttles
 *     (PATCH workers.max=0) only when running with --apply.
 *  5. GET /v2/billing/balance → warn when below balanceFloorUsd
 *     (balance reflects spend only after scale-down, so it is used as a
 *     floor guarantee, never as the real-time signal — see docs/GOVERNOR.md).
 *
 * Read-only by default. PATCH is sent only with --apply. GET only otherwise.
 */

import { RunPodApiError, RunPodClient } from '../client.js';
import { ServerlessCatalog } from './catalog.js';
import type { EndpointConfig, GovernorConfig } from './config.js';
import { JsonlLogger } from './jsonl.js';
import {
  type GovernorState,
  getState,
  loadState,
  saveState,
  utcDayKey,
  utcMonthKey,
} from './state.js';
import { classifyWorkers, type WorkerTracker, type WorkerView } from './workers.js';
import { throttleEndpoint } from './throttle.js';

interface EndpointMeta {
  config: EndpointConfig;
  initTimeoutSeconds: number;
  pools: string[];
}

interface RateBreakdown {
  rateUsdPerHour: number;
  workers: Array<{ id: string; status: string; uptimeSeconds: number | null; priceUsdPerHour: number | null; gpuCount: number }>;
  unknownPrice: boolean;
}

export interface GovernorRunOptions {
  apply: boolean;
  /** Exit after this many ms (used by the smoke run); undefined = run until SIGINT. */
  durationMs?: number;
  /** Single poll then exit. */
  once: boolean;
  /** Restore previously throttled endpoints (requires apply). */
  restore: boolean;
}

export class BudgetGovernor {
  private readonly client: RunPodClient;
  private readonly catalog: ServerlessCatalog;
  private readonly logger: JsonlLogger;
  private readonly cfg: GovernorConfig;
  private readonly state: GovernorState;
  private readonly trackers = new Map<string, WorkerTracker>();
  private readonly metas = new Map<string, EndpointMeta>();
  private readonly lastTickMs = new Map<string, number>();
  private readonly opts: GovernorRunOptions;
  private stopped = false;

  constructor(cfg: GovernorConfig, client: RunPodClient, opts: GovernorRunOptions, logger: JsonlLogger) {
    this.cfg = cfg;
    this.client = client;
    this.opts = opts;
    this.logger = logger;
    this.catalog = new ServerlessCatalog(client, cfg.catalogRefreshSeconds * 1000);
    this.state = loadState(cfg.stateFile);
  }

  async run(): Promise<void> {
    await this.catalog.ensureFresh(true);
    await this.discoverEndpoints();

    const deadline = this.opts.durationMs !== undefined ? Date.now() + this.opts.durationMs : undefined;
    const intervalMs = this.cfg.pollIntervalSeconds * 1000;

    while (!this.stopped) {
      const tickStart = Date.now();
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.error('poll_error', { message: errorMessage(err) });
      }
      if (this.opts.once || (deadline !== undefined && Date.now() >= deadline)) break;
      const elapsed = Date.now() - tickStart;
      await sleep(Math.max(0, intervalMs - elapsed));
    }
    saveState(this.cfg.stateFile, this.state);
    this.logger.info('shutdown', { reason: this.stopped ? 'signal' : 'deadline' });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Discover monitored endpoints: configured ids ∪ (autoDiscover ? all endpoints : ∅). */
  private async discoverEndpoints(): Promise<void> {
    const ids = new Set<string>();
    for (const e of this.cfg.endpoints) ids.add(e.id);

    if (this.cfg.autoDiscover) {
      const res = await this.client.get('/v2/serverless');
      const list = (res.data as { endpoints?: Array<{ id?: unknown }> }).endpoints ?? [];
      for (const e of list) {
        if (typeof e['id'] === 'string') ids.add(e['id']);
      }
    }

    for (const id of ids) {
      const configured = this.cfg.endpoints.find((e) => e.id === id);
      const config: EndpointConfig = configured ?? { id, limits: this.cfg.defaultLimits };
      try {
        const detail = await this.client.get('/v2/serverless/{id}', { path: { id } });
        const d = detail.data as {
          name?: string;
          workers?: { initTimeout?: number | null };
          gpu?: { pools?: unknown } | null;
        };
        const initTimeout = typeof d.workers?.['initTimeout'] === 'number' ? d.workers['initTimeout'] : 1800;
        const pools = Array.isArray(d.gpu?.['pools'])
          ? (d.gpu?.['pools'] as unknown[]).filter((p): p is string => typeof p === 'string')
          : [];
        this.metas.set(id, { config, initTimeoutSeconds: initTimeout, pools });
        this.logger.info('watch_start', {
          endpoint: id,
          name: d.name ?? config.name ?? null,
          limits: config.limits,
          initTimeoutSeconds: initTimeout,
          pools,
        });
      } catch (err) {
        this.logger.error('watch_start_failed', { endpoint: id, message: errorMessage(err) });
      }
    }
    if (this.metas.size === 0) this.logger.warn('no_endpoints', {});
  }

  private async pollOnce(): Promise<void> {
    const nowMs = Date.now();
    await this.catalog.ensureFresh();

    let balanceUsd: number | undefined;
    try {
      const res = await this.client.get('/v2/billing/balance');
      const amount = (res.data as { balanceAmount?: unknown }).balanceAmount;
      if (typeof amount === 'number') balanceUsd = amount;
    } catch (err) {
      this.logger.error('balance_error', { message: errorMessage(err) });
    }

    for (const [id, meta] of this.metas) {
      try {
        await this.pollEndpoint(id, meta, nowMs, balanceUsd);
      } catch (err) {
        this.logger.error('endpoint_poll_error', { endpoint: id, message: errorMessage(err) });
      }
    }

    if (balanceUsd !== undefined) this.checkBalanceFloor(balanceUsd);
    saveState(this.cfg.stateFile, this.state);
  }

  private async pollEndpoint(
    id: string,
    meta: EndpointMeta,
    nowMs: number,
    balanceUsd: number | undefined,
  ): Promise<void> {
    const res = await this.client.get('/v2/serverless/{id}/workers', { path: { id } });
    const raw = (res.data as { workers?: unknown }).workers;
    if (!Array.isArray(raw)) throw new Error('workers: unexpected response shape');
    const views: WorkerView[] = raw.map((w) => {
      const x = w as Record<string, unknown>;
      return {
        id: String(x['id'] ?? ''),
        status: String(x['status'] ?? ''),
        startedAt: typeof x['startedAt'] === 'string' ? (x['startedAt'] as string) : null,
        uptimeSeconds: typeof x['uptimeSeconds'] === 'number' ? (x['uptimeSeconds'] as number) : null,
        gpuTypeId: typeof x['gpuTypeId'] === 'string' ? (x['gpuTypeId'] as string) : null,
        gpuCount: typeof x['gpuCount'] === 'number' ? (x['gpuCount'] as number) : 0,
        dataCenterId: typeof x['dataCenterId'] === 'string' ? (x['dataCenterId'] as string) : null,
      };
    });

    let tracker = this.trackers.get(id);
    if (!tracker) {
      tracker = new Map();
      this.trackers.set(id, tracker);
    }
    const { billable, rejected, phantomSeen } = classifyWorkers(views, nowMs, meta.initTimeoutSeconds, tracker);

    const rate = this.computeRate(id, meta, billable);
    const st = getState(this.state, id, nowMs);

    const last = this.lastTickMs.get(id);
    this.lastTickMs.set(id, nowMs);
    const deltaSeconds = last === undefined ? 0 : clamp((nowMs - last) / 1000, 0, this.cfg.pollIntervalSeconds * 4);
    const accrualUsd = (rate.rateUsdPerHour / 3600) * deltaSeconds;

    // Session bookkeeping: session = continuous span with ≥1 billable worker.
    // Backfill trusts only workers with live uptime evidence (uptimeSeconds
    // present and self-consistent). An INITIALIZING record's startedAt can
    // belong to a stale placeholder, so it never seeds backfill.
    if (billable.length > 0 && !st.session.active) {
      st.session.active = true;
      const confirmed = billable.filter((w) => w.uptimeSeconds !== null);
      const earliest = confirmed
        .map((w) => (w.startedAt ? Date.parse(w.startedAt) : NaN))
        .filter((t) => Number.isFinite(t))
        .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null);
      let backfilledUsd = 0;
      if (earliest !== null) {
        const backfillSeconds = clamp((nowMs - earliest) / 1000, 0, this.cfg.maxSessionBackfillSeconds);
        backfilledUsd = (rate.rateUsdPerHour / 3600) * backfillSeconds;
        st.session.startedAt = new Date(earliest).toISOString();
        st.session.accruedUsd += backfilledUsd;
        // Conservative: backfilled time counts toward day/month caps too.
        st.day.accruedUsd += backfilledUsd;
        st.month.accruedUsd += backfilledUsd;
      } else {
        st.session.startedAt = new Date(nowMs).toISOString();
      }
      this.logger.info('session_start', {
        endpoint: id,
        sessionStartedAt: st.session.startedAt,
        billable: billable.length,
        backfilledUsd: round6(backfilledUsd),
      });
    }
    if (billable.length === 0 && st.session.active) {
      st.session.active = false;
      this.logger.info('session_end', {
        endpoint: id,
        sessionUsd: round6(st.session.accruedUsd),
        sessionStartedAt: st.session.startedAt,
      });
      st.session.warned = false;
      st.session.breached = false;
      // Keep st.session.throttled until restored (manual or --restore).
    } else if (billable.length > 0) {
      st.session.accruedUsd += accrualUsd;
    }
    st.day.accruedUsd += accrualUsd;
    st.month.accruedUsd += accrualUsd;

    this.logger.info('tick', {
      endpoint: id,
      totalRecords: views.length,
      billable: billable.length,
      workers: rate.workers,
      rejected: rejected.map((r) => ({ id: r.worker.id, status: r.worker.status, reason: r.reason })),
      phantomSeen,
      unknownPrice: rate.unknownPrice,
      hourlyRateUsd: round6(rate.rateUsdPerHour),
      sessionUsd: round6(st.session.accruedUsd),
      dayUsd: round6(st.day.accruedUsd),
      monthUsd: round6(st.month.accruedUsd),
      balanceUsd: balanceUsd ?? null,
    });

    this.evaluateLimits(id, meta.config, st, nowMs);
  }

  private computeRate(id: string, meta: EndpointMeta, billable: WorkerView[]): RateBreakdown {
    let rate = 0;
    let unknownPrice = false;
    const workers: RateBreakdown['workers'] = [];
    for (const w of billable) {
      let price = w.gpuTypeId ? this.catalog.priceForGpu(w.gpuTypeId) : undefined;
      if (price === undefined && meta.pools.length > 0) {
        // Conservative fallback: highest serverless price across the endpoint's pools.
        const poolMax = Math.max(...meta.pools.map((p) => this.catalog.maxPriceForPool(p) ?? 0));
        if (poolMax > 0) price = poolMax;
      }
      if (price === undefined) unknownPrice = true;
      const p = price ?? 0;
      rate += p * Math.max(1, w.gpuCount);
      workers.push({
        id: w.id,
        status: w.status,
        uptimeSeconds: w.uptimeSeconds,
        priceUsdPerHour: price ?? null,
        gpuCount: w.gpuCount,
      });
    }
    if (unknownPrice) {
      this.logger.warn('price_unknown', {
        endpoint: id,
        hint: 'gpuTypeId missing from catalog; rate contribution counted as 0',
      });
    }
    return { rateUsdPerHour: rate, workers, unknownPrice };
  }

  private evaluateLimits(
    id: string,
    config: EndpointConfig,
    st: ReturnType<typeof getState>,
    nowMs: number,
  ): void {
    const buckets = [
      { label: 'session' as const, accruedUsd: st.session.accruedUsd, limit: config.limits.sessionUsd, flags: st.session, active: st.session.active },
      { label: 'day' as const, accruedUsd: st.day.accruedUsd, limit: config.limits.dayUsd, flags: st.day, active: true },
      { label: 'month' as const, accruedUsd: st.month.accruedUsd, limit: config.limits.monthUsd, flags: st.month, active: true },
    ];
    for (const b of buckets) {
      if (b.limit === undefined) continue;
      if (!b.active) continue;
      const warnAt = b.limit * this.cfg.warnRatio;
      if (!b.flags.warned && b.accruedUsd >= warnAt && b.accruedUsd < b.limit) {
        b.flags.warned = true;
        this.logger.warn('threshold_warn', {
          endpoint: id,
          bucket: b.label,
          accruedUsd: round6(b.accruedUsd),
          limitUsd: b.limit,
          warnRatio: this.cfg.warnRatio,
        });
      }
      if (!b.flags.breached && b.accruedUsd >= b.limit) {
        b.flags.breached = true;
        this.logger.warn('threshold_breach', {
          endpoint: id,
          bucket: b.label,
          accruedUsd: round6(b.accruedUsd),
          limitUsd: b.limit,
          apply: this.opts.apply,
        });
        if (this.opts.apply) {
          void throttleEndpoint(this.client, id, this.state, getState, this.logger, `${b.label}-limit`).catch((err) => {
            this.logger.error('throttle_error', { endpoint: id, message: errorMessage(err) });
          });
        } else {
          this.logger.warn('throttle_skipped_dry_run', { endpoint: id, bucket: b.label });
        }
      }
    }
    void nowMs;
  }

  private checkBalanceFloor(balanceUsd: number): void {
    const floor = this.cfg.balanceFloorUsd;
    if (floor === undefined) return;
    if (balanceUsd >= floor) return;
    this.logger.warn('balance_floor_low', {
      balanceUsd,
      floorUsd: floor,
      note: 'balance reflects only after scale-down; floor guarantee is conservative',
      apply: this.opts.apply,
    });
    if (this.cfg.balanceFloorAction === 'throttle' && this.opts.apply) {
      for (const id of this.metas.keys()) {
        void throttleEndpoint(this.client, id, this.state, getState, this.logger, 'balance-floor').catch((err) => {
          this.logger.error('throttle_error', { endpoint: id, message: errorMessage(err) });
        });
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function errorMessage(err: unknown): string {
  if (err instanceof RunPodApiError) return `${err.name} ${err.status}: ${err.message}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { utcDayKey, utcMonthKey };
