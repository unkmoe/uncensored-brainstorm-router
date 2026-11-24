# Budget governor

`src/governor/` watches your RunPod serverless spend in real time and can throttle
automatically when a budget is exceeded. It exists because RunPod's own billing
interfaces are not suitable for live monitoring (details below).

## Usage

```bash
cp governor.config.example.json governor.config.json   # edit endpoint ids + limits
npm run governor -- --config governor.config.json            # dry-run (warn only)
npm run governor -- --config governor.config.json --apply    # + auto-throttle
# options: --once (single poll)  --duration <sec>  --restore <endpointId>
```

## Configuration

| Key | Meaning |
| --- | --- |
| `pollIntervalSeconds` | poll cadence (default 30) |
| `warnRatio` | warn at limits × ratio (default 0.8) |
| `balanceFloorUsd` / `balanceFloorAction` | hard floor from the balance API (`warn` or `throttle`) |
| `endpoints[].limits` | `sessionUsd` / `dayUsd` / `monthUsd` per endpoint (unset buckets unmonitored) |
| `autoDiscover` | watch endpoints not listed in the config |

Logs are JSONL; API key material is scrubbed at serialization time.

## How it estimates

The governor bills **live workers × catalog price × elapsed time**, per endpoint:

1. Poll `GET /v2/serverless/{id}/workers`; classify each worker as billable or not.
2. Multiply billable uptime by the endpoint pool's serverless price from
   `GET /v2/catalog/gpus`.
3. Accumulate per-session/day/month buckets in a local state file.
4. On threshold breach (with `--apply`): `PATCH /v2/serverless/{id}` sets
   `workers.max = 0` — read-before-write with pre-change snapshot and post-verify,
   never a delete. `--restore` puts the original values back.

## RunPod billing quirks you must know (measured)

These are why the governor estimates instead of trusting balances:

- **The balance API lags by design.** During worker uptime the balance doesn't move;
  charges post once the worker scales down. Fine as a floor check, useless for
  live caps.
- **Billing history lags hard.** `GET /v2/billing/serverless` showed zero records for
  the same day even after confirmed charges — day-batch aggregation. Use it for
 事后 verification, not monitoring.
- **The workers list contains phantom records.** An endpoint shows IDLE worker records
  that never ran (created with the endpoint) and stale ones after scale-down. The
  governor rejects records with no live uptime instead of counting them.
- **Balance is account-wide.** Multiple endpoints share one wallet; per-endpoint
  attribution is only possible via worker-uptime estimation (what the governor does).
- **Idle timeout costs money** — every warm-down waits `idleTimeout` (default 300 s ≈
  $0.11 per session at $1.22/hr). Tighten it if your traffic is bursty, or accept it
  as the price of fast follow-ups.

## Cost sanity numbers (measured, 32B fp8 × A40)

- Warm session: **~$0.6 per 30 min** brainstorm.
- Full cold start: ~6 min of billed boot time (only when a worker actually spins up).
- FlashBoot revival: seconds — free, keeps sessions cheap.
- Judge: ~$0.00002/turn (or $0 with the local judge).
