# Roadmap & repository layout

## What's in this repo

```
pi-extensions/
  brainstorm-router.ts   # pi virtual model: judge → 3-branch routing (Jev → logprob fallback)
  judge-probe.ts        # judge availability probe (no chat model billed)
src/
  client.ts, ratelimit.ts, generated/   # typed RunPod API v2 client (429-aware)
  governor/              # budget monitor + auto-throttle CLI (docs/GOVERNOR.md)
  core/                 # OpenAI-compatible HTTP core (judge + AUP + budget embedded)
  smoke.ts               # read-only connectivity check
calibration/
  friction.yaml, aup.yaml, aup-expanded.yaml   # labeled test sets
  harness-jev.ts, harness-local.ts, harness.ts # batteries (resume-aware, budget-guarded)
  analyze-*.ts, detect-simplified.ts           # confusion matrices, contamination check
  results/               # raw JSONL + analysis (checked in)
docs/                   # deployment, judge, calibration, governor, this file
AUP.md                   # content policy (spec, threshold fixed)
```

## Deliberately deferred: the MCP adapter

An MCP server exposing `brainstorm()` / `judge()` / `budget_status()` tools is
**planned but intentionally not in the first release**, for one measured reason:

MCP tool results are returned as a single blob, which the *host's own aligned model*
then summarizes/reformats for the user. That reshaping is a second censorship layer —
it reintroduces exactly the friction this package exists to remove. The
OpenAI-compatible HTTP core avoids the problem structurally (the client renders the
model's raw tokens directly, with streaming).

The adapter itself is thin (it would wrap the core), so the plan is demand-driven:
**open an issue if you need MCP**, and it gets prioritized. Note that hosting-wise the
adapter has a natural home (any VM host; agent-facing MCP over streamable HTTP), so
deferral costs nothing.

## Planned

- **npm package** (`npx uncensored-brainstorm-router`) once the repo is public —
  install is currently `git clone && npm install`.
- **More backend recipes** — GPUs and models we haven't measured (L40S, H100;
  14B abliterated for cheaper tiers). Bring calibration items and recipes via issues.
- **fp8 vs bf16 quality quantification** — deferred as low-value (no degradation
  observed in any battery; requires an A100 at $2.99/hr). Trigger: quality complaints.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit, strict
npm run build
npm run smoke         # read-only live API check (needs RUNPOD_API_KEY)
```

Calibration harnesses run as pi extensions and are resume-aware — see
[docs/CALIBRATION.md](CALIBRATION.md) for the exact invocations.

## Non-goals

- Removing the AUP gate, making its threshold configurable, or shipping a
  "jailbreak mode". This is a spec decision; see [AUP.md](../AUP.md).
- Hosting anyone's prompts. BYO keys; the only optional external call is the judge,
  and there is a fully local option ([docs/JUDGE.md](JUDGE.md)).

---

## The problem this solves (full narrative)

Mainstream assistants refuse, hedge, or quietly narrow lawful-but-controversial
brainstorming: sharp institutional critique, taboo thought experiments, adversarial
perspectives, adult fiction. Self-hosting an uncensored model fixes the friction but
creates two new problems: **cost-control accidents** (idle GPU burn, runaway spend)
and **no illegal-content gate** — the exact content that gets GPU accounts frozen.
This package puts a dual-use judge in front of uncensored RunPod backends so that
lawful friction is routed around, illegal categories are refused before any GPU second
is billed, and a budget governor watches spend in real time. You bring your own keys;
nothing leaves your account except (optionally zero — see docs/JUDGE.md) judge tokens.

## Why this vs alternatives

| Feature | OpenRouter-hosted uncensored models | raw RunPod DIY | Venice.ai | **this package** |
| --- | --- | --- | --- | --- |
| Uncensored backends | ○ (theirs) | ○ (yours) | ○ (theirs) | ○ (yours) |
| Illegal-category gate in the box | ✗ | ✗ | ✗ (opaque) | **✓ measured** |
| Friction auto-escalation per turn | ✗ | ✗ | ✗ | **✓ (pi extension)** |
| Budget cap + auto-throttle | ✗ | ✗ | ✗ | **✓ (governor)** |
| Prompts stay on your account | ✗ | ○ | ✗ | **✓ / judge optional local** |
| Measured judge accuracy published | ✗ | n/a | ✗ | **✓ (calibration in repo)** |

## Design philosophy

1. **Friction removal and illegal-category blocking are different jobs** — the first
   is UX, the second is survival. One judge does both in a single classify call.
2. **The gate lives outside the model.** Uncensored fine-tunes can't be asked to
   police themselves; a classifier in front of them can, and its verdict is auditable.
3. **Measured numbers only.** Every threshold comes from a battery whose raw JSONL
   is checked in.
4. **BYO everything.** Your RunPod account, your judge provider (or your own CPU).
5. **Honest limitations.** Including the ones that cost us debugging rounds.

## Architecture (full picture)

```
pi extension (verified end to end)
  Judge (Jev, 1 call/turn) ─┬─ AUP ≥ 0.6       → REFUSE (no model billed)
                             ├─ friction ≥ 0.2  → uncensored backend (RunPod serverless vLLM)
                             └─ otherwise       → mainstream session model
                             + session-state caching, sticky routing (prompt-cache friendly)

HTTP core (src/core, verified via direct requests)
  POST /v1/chat/completions ── AUP ≥ 0.6 → REFUSE (HTTP 400, no backend call)
                              else → uncensored backend
                              (route label "uncensored"/"default" is telemetry; X-Judge-* headers)

RunPod REST v2 (src/client.ts, typed) ── budget governor (src/governor)
```
