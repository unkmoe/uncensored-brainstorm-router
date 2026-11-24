/**
 * Read-only smoke test for runpod-client.
 *
 * - Loads $RUNPOD_API_KEY from worker-tokens/runpod.env (or the environment).
 * - Calls: GET /v2/billing/balance, GET /v2/catalog/gpus (RTX 4090),
 *   GET /v2/serverless (endpoint list), GET /v2/pods.
 * - Prints a masked summary (identifiers are partially masked).
 * - GET-only; exit code 0 on success.
 */

import { RunPodClient, RunPodApiError } from './client.js';
import { formatRateLimit } from './ratelimit.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Load KEY=VALUE lines from worker-tokens/runpod.env into a record. */
function loadTokenFile(relative = 'worker-tokens/runpod.env'): Record<string, string> {
  const file = path.resolve(process.cwd(), relative);
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** Partially mask an identifier: keep first 3 and last 2 characters. */
function mask(id: string | null | undefined): string {
  if (id == null || id.length === 0) return '(none)';
  if (id.length <= 5) return `${id[0]!}***`;
  return `${id.slice(0, 3)}***${id.slice(-2)}`;
}

const money = (n: number | null | undefined) => (n == null ? '(unknown)' : `$${n.toFixed(2)}`);

async function main(): Promise<number> {
  const fromFile = loadTokenFile();
  const apiKey = process.env['RUNPOD_API_KEY'] ?? fromFile['RUNPOD_API_KEY'];
  if (!apiKey) {
    console.error('smoke: RUNPOD_API_KEY not found (env or worker-tokens/runpod.env)');
    return 1;
  }
  const client = new RunPodClient({ apiKey });

  // 1) Balance
  const bal = await client.getBalance();
  const b = bal.data as { balanceAmount?: number; billingMode?: string };
  console.log('[balance]');
  console.log(`  billingMode : ${b.billingMode ?? '(unknown)'}`);
  console.log(`  balance     : ${money(b.balanceAmount)}`);
  console.log(`  rateLimit   : ${formatRateLimit(bal.rateLimit)}`);

  // 2) RTX 4090 pricing
  const gpus = await client.listGpus({ include: ['AVAILABILITY'], product: ['POD'] });
  const gpusList = (gpus.data as { gpus?: Array<Record<string, unknown>> }).gpus ?? [];
  const rtx4090 = gpusList.find((g) => g['id'] === 'NVIDIA GeForce RTX 4090');
  console.log('[catalog: RTX 4090]');
  if (rtx4090) {
    const price = (rtx4090['price'] ?? {}) as Record<string, number | undefined>;
    console.log(`  secure    : ${money(price['secure'])}/h`);
    console.log(`  community : ${money(price['community'])}/h`);
    console.log(`  serverless: ${money(price['serverless'])}/h`);
    console.log(`  availability: ${String(rtx4090['availability'] ?? '(unknown)')}`);
  } else {
    console.log(`  RTX 4090 not found in ${gpusList.length} GPU types`);
  }

  // 3) Serverless endpoints (masked)
  const sl = await client.listServerless();
  const endpoints =
    ((sl.data as { endpoints?: Array<Record<string, unknown>> }).endpoints ?? []) as Array<Record<string, unknown>>;
  console.log(`[serverless endpoints] (${endpoints.length})`);
  for (const ep of endpoints) {
    const gpu = (ep['gpu'] ?? {}) as Record<string, unknown>;
    const workers = (ep['workers'] ?? {}) as Record<string, unknown>;
    console.log(
      `  id=${mask(String(ep['id'] ?? ''))} name=${JSON.stringify(String(ep['name'] ?? ''))} ` +
        `pools=${JSON.stringify(gpu['pools'] ?? [])} workers(min=${workers['min'] ?? '?'} max=${workers['max'] ?? '?'})`,
    );
  }

  // 4) Pods (masked, count only)
  const pods = await client.listPods();
  const podsList = ((pods.data as { pods?: Array<Record<string, unknown>> }).pods ?? []) as Array<Record<string, unknown>>;
  console.log(`[pods] (${podsList.length})`);
  for (const p of podsList) {
    const gpu = (p['gpu'] ?? {}) as Record<string, unknown>;
    console.log(
      `  id=${mask(String(p['id'] ?? ''))} status=${String(p['status'] ?? '?')} gpu=${String(gpu['id'] ?? '(cpu)')} ` +
        `cost=${money(Number(p['cost'] ?? NaN))}/h`,
    );
  }

  console.log('\nsmoke: OK');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof RunPodApiError) {
      console.error(`smoke: API error ${err.status}: ${err.message}`);
      console.error(`  rateLimit: ${formatRateLimit(err.rateLimit)}`);
    } else {
      console.error('smoke: failed:', err);
    }
    process.exit(1);
  });
