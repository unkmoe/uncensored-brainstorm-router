/**
 * Serverless GPU price catalog (read-only wrapper around GET /v2/catalog/gpus).
 *
 * `price.serverless` is the list price per GPU per hour from the pool the GPU
 * belongs to (GpuType schema in the RunPod REST API v2). Negotiated discounts
 * are not reflected, which makes this estimate an upper bound for
 * discounted accounts (see docs/GOVERNOR.md).
 */

import type { RunPodClient } from '../client.js';

export class ServerlessCatalog {
  private readonly client: RunPodClient;
  private readonly byGpuType = new Map<string, number>();
  private readonly byPoolMax = new Map<string, number>();
  private lastRefreshMs = 0;
  private refreshing: Promise<void> | null = null;

  constructor(client: RunPodClient, private readonly refreshIntervalMs: number) {
    this.client = client;
  }

  /** Fetch (or re-fetch if stale) the catalog. Tolerates GPUs without a serverless price. */
  async ensureFresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastRefreshMs < this.refreshIntervalMs) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchCatalog()
      .then(() => {
        this.lastRefreshMs = Date.now();
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async fetchCatalog(): Promise<void> {
    const res = await this.client.get('/v2/catalog/gpus');
    const gpus = (res.data as { gpus?: unknown }).gpus;
    if (!Array.isArray(gpus)) throw new Error('catalog: unexpected response shape (gpus missing)');
    const byGpuType = new Map<string, number>();
    const byPoolMax = new Map<string, number>();
    for (const g of gpus) {
      const gpu = g as {
        id?: unknown;
        pool?: unknown;
        price?: { serverless?: unknown } | null;
      };
      if (typeof gpu['id'] !== 'string') continue;
      const price = gpu['price']?.['serverless'];
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
      byGpuType.set(gpu['id'], price);
      if (typeof gpu['pool'] === 'string') {
        const cur = byPoolMax.get(gpu['pool']);
        if (cur === undefined || price > cur) byPoolMax.set(gpu['pool'], price);
      }
    }
    this.byGpuType.clear();
    for (const [k, v] of byGpuType) this.byGpuType.set(k, v);
    this.byPoolMax.clear();
    for (const [k, v] of byPoolMax) this.byPoolMax.set(k, v);
  }

  /** Serverless USD/hour for one GPU of the given type, or undefined if unknown. */
  priceForGpu(gpuTypeId: string): number | undefined {
    return this.byGpuType.get(gpuTypeId);
  }

  /** Highest serverless USD/hour across the GPUs of a pool (conservative fallback). */
  maxPriceForPool(pool: string): number | undefined {
    return this.byPoolMax.get(pool);
  }
}
