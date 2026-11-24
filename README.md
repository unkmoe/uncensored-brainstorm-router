# uncensored-brainstorm-router

**Removes alignment friction from lawful brainstorming — while shipping an illegal-category gate in the same package.**

A dual-question judge runs on every user turn. The package ships in two shapes that
share one judge:

- **pi extension** (tested end to end): routes three ways — a mainstream model for
  mundane turns, an uncensored RunPod backend for lawful turns that mainstream
  assistants would refuse or dilute, and a **hard refusal with no model called at
  all** for illegal categories.
- **OpenAI-compatible HTTP core** (tested via direct API calls): gates a single
  uncensored backend — AUP refusals return before any GPU second is billed, and the
  friction score rides along as response headers.

pi is the only verified client; other OpenAI clients are architecture, not promises
(see Limitations).

```
pi extension:   Judge (Jev, 1 call/turn, ~250 ms) ─┬─ AUP ≥ 0.6       → REFUSE (no model billed)
                                                   ├─ friction ≥ 0.2  → uncensored backend (32B, $1.22/hr)
                                                   └─ otherwise       → mainstream model
HTTP core:      POST /v1/chat/completions ── AUP ≥ 0.6 → REFUSE · else → uncensored backend
                                                      (friction score in X-Judge-* headers)
```

Measured, not claimed: friction **13/15 detected, 0 false positives** · illegal-category
accuracy **50/50 violations caught** (80-item battery) · judge cost **~$0.00002/turn** ·
session cost **~$0.6 / 30 min** · full raw results in [docs/CALIBRATION.md](docs/CALIBRATION.md).

> **This is not a jailbreak project.** The judge is dual-use by design: the same
> classifier that escalates lawful friction also refuses illegal categories, and the
> AUP threshold is fixed by spec, not configurable. See [AUP.md](AUP.md).

## The problem

Mainstream assistants refuse, hedge, or quietly narrow lawful-but-controversial
brainstorming: sharp institutional critique, taboo thought experiments, adversarial
perspectives, adult fiction. Self-hosting an uncensored model fixes the friction but
creates two new problems: **cost-control accidents** (idle GPU burn, runaway spend) and
**no illegal-content gate** — the exact content that gets GPU accounts frozen.

## The solution

In pi, friction is routed around (mundane turns stay on your main model; frictional
turns go to uncensored backends on RunPod serverless — scale-to-zero, ~$0 idle). Via
the HTTP core, you get the same uncensored backend with the same illegal-category
refusal in front of it. In both shapes a budget governor estimates spend in real
time. You bring your own RunPod key; nothing leaves your account except judge tokens
(which you can also keep on your own machine — see [docs/JUDGE.md](docs/JUDGE.md)).

## Why use this?

| Feature | vs. OpenRouter-hosted uncensored models | vs. raw RunPod DIY | vs. Venice.ai |
| --- | --- | --- | --- |
| Uncensored backends | ○ (theirs) | ○ (yours) | ○ (theirs) |
| Illegal-category gate in the box | ✗ | ✗ | ✗ (opaque) |
| Friction auto-escalation per turn | ✗ | ✗ | ✗ |
| Budget cap + auto-throttle | ✗ | ✗ | ✗ |
| Prompts stay on your account | ✗ | ○ | ✗ |
| Measured judge accuracy published | ✗ | n/a | ✗ |

## Quick example

```bash
git clone https://github.com/<you>/uncensored-brainstorm-router && cd uncensored-brainstorm-router
npm install
export RUNPOD_API_KEY=rpa_…            # RunPod key (see Setup)
npm run smoke                           # balance, catalog, endpoints — read-only check

# Option A — HTTP core (verified via direct requests; pi models.json is documented
#   in docs/DEPLOYMENT.md but not yet exercised):
npm run core &                         # → http://localhost:8787/v1
curl http://localhost:8787/v1/chat/completions -H 'content-type: application/json' -d '{
  "model":"brainstorm","messages":[{"role":"user","content":"uncensored: 遠慮のない意見を"}]}'

# Option B — pi extension (virtual model with per-turn routing):
pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm
# mundane question  → mainstream model
# "uncensored: …"   → uncensored backend   (AUP check still applies)
# illegal category  → refused, no model called
```

Every feature claim above is reproducible from `calibration/` — run the batteries yourself.

## Design philosophy

1. **Friction removal and illegal-category blocking are different jobs** — the first is
   UX, the second is survival. One judge does both in a single classify call.
2. **The gate lives outside the model.** Uncensored fine-tunes can't be asked to police
   themselves; a classifier in front of them can, and its verdict is auditable.
3. **Measured numbers only.** Every threshold in this repo comes from a battery whose
   raw JSONL is checked in. Re-run `calibration/` if you don't trust ours.
4. **BYO everything.** Your RunPod account, your judge provider (or your own CPU) —
   no hosted service in the middle of your prompts.
5. **Honest limitations.** Listed below, including the ones that cost us debugging rounds.

## Installation

```bash
git clone <repo-url> && cd uncensored-brainstorm-router
npm install && npm run typecheck
```

*Requirements:* Node 20+, a RunPod account, and (optionally) OpenCode credits for the
Jev judge. An npm package (`npx uncensored-brainstorm-router`) is planned once the
public repo is announced.

## Setup

1. **RunPod API key** — console → Settings → API Keys. Grant: serverless management,
   billing read, and **AI API access per endpoint** (the per-endpoint grant is the #1
   pitfall — see Troubleshooting).
2. **Judge** — default is Jev via OpenCode credits (`jev-1.13`, ~$0.00002/judgment, no
   training on your data). Alternatives: your own vLLM logprob judge, or a fully local
   CPU judge. Details: [docs/JUDGE.md](docs/JUDGE.md).
3. **Backend** — one RunPod serverless endpoint. Default recipe: Qwen2.5-32B-Instruct-
   abliterated fp8 on A40, $1.22/hr, tool-call capable, scale-to-zero. Copy-paste
   config JSON: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
4. Point the router at it: `RUNPOD_OPENAI_BASE=https://api.runpod.ai/v2/<id>/openai/v1`
   (+ `RUNPOD_UNCENSORED_MODEL`), then start `npm run core` or the pi extension.

## Commands & API

| Command | What it does |
| --- | --- |
| `npm run core` | OpenAI-compatible HTTP core on :8787 (`/v1/chat/completions` streaming, `/v1/models`, `/health`) |
| `npm run smoke` | Read-only RunPod connectivity check (balance, catalog, endpoints) |
| `npm run governor -- --config <f>` | Budget monitor (dry-run); `--apply` adds auto-throttle |
| `pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm` | pi virtual model with per-turn routing |

Key environment variables (full list in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
the headers of each source file):

| Variable | Purpose |
| --- | --- |
| `RUNPOD_API_KEY` | RunPod key (management + inference) |
| `RUNPOD_OPENAI_BASE` / `RUNPOD_UNCENSORED_MODEL` | Your backend endpoint / model |
| `OPENCODE_API_KEY` | Jev judge (paid variant, no training) |
| `BRAINSTORM_JUDGE` | `jev` \| `vllm` \| `auto` (default auto with logprob fallback) |
| `BALANCE_FLOOR` | Core warns at start if balance is under this (default $1) |

Core responses carry judge telemetry as headers: `X-Judge-Route`, `X-Judge-Friction`,
`X-Judge-Aup`, `X-Judge-Latency-Ms`.

## Architecture

```
client (curl — verified · pi via models.json — documented · other OpenAI clients — untested)
   │  OpenAI-compatible
   ▼
HTTP core (src/core) ── judge (src/core/jev: System One → Jev; fallback: vLLM logprobs)
   │                      │ friction choice + AUP bool, ONE classify call per user turn
   │                      ▼
   │              AUP ≥ 0.6 ───────────► REFUSE (HTTP 400, no backend call)
   │              otherwise ───────────► uncensored backend (route label:
   │                                     "uncensored" if tagged/friction ≥ 0.2,
   │                                     "default" otherwise — same backend, label is telemetry)
   ▼
RunPod REST v2 (src/client.ts, typed) ── budget governor (src/governor)
```

The pi extension (`pi-extensions/brainstorm-router.ts`) runs the identical judge and
adds the third branch — mundane turns go to your mainstream session model — with
session-state caching and sticky routing for prompt-cache friendliness.

## Troubleshooting (top 5)

1. **403 from the inference gateway but management calls work** — Restricted RunPod
   keys grant *AI API* access per endpoint in the console only; there is no REST way
   to grant it. Add your endpoint to the key's AI API allow-list.
2. **Jev returns 400 / 402** — the free judge variant needs a training opt-in (avoid);
   the paid `jev-1.13` needs OpenCode credits. Without either, the router silently
   falls back to the local logprob judge (weaker friction detection — see
   [docs/CALIBRATION.md](docs/CALIBRATION.md)).
3. **First request after idle hangs minutes, then a 504** — serverless cold start
   (model download) can exceed the edge proxy timeout; the job usually completes
   server-side, so retry. Warm the endpoint with a one-token request first.
4. **Tool calls look "broken"** — detect them by the `tool_calls` array, not
   `finish_reason`: the default backend can emit a populated array with
   `finish_reason: stop` under forced choice.
5. **Worker boot fails with "ran out of disk"** — 32B backends need container disk
   **100GB** (the bf16 download is 65.5GB); the 50GB default is too small.

## Limitations

- **Only pi is a verified client.** The pi extension is tested end to end; the HTTP
  core is tested with direct requests. Cursor / Open WebUI / claude-code-router are
  *architecturally* supported (standard OpenAI-compatible API) but not yet exercised —
  connect-and-report if you try them.
- **Tool calls are backend-dependent.** Default Qwen-32B-abliterated fires reliably
  (10/10 on weak instructions); Dolphin-24B fired 0/5 even on explicit instructions
  in follow-up batteries — chat-only, do not route tools to it.
- **fp8 vs bf16 quality delta is unquantified** (no degradation observed in any
  battery; measuring needs an A100 at $2.99/hr). Revisit if quality complaints appear.
- **Cold starts are real**: ~6 min full, ~2.5 min with a volume cache, seconds with
  FlashBoot — but config changes invalidate the snapshot (1-2 cold requests after any
  PATCH). Full numbers: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **The judge sees your prompts** (hosted Jev). For a zero-egress setup, run the
  AUP judgment locally on CPU (Kev-4B, verified 25/25) — [docs/JUDGE.md](docs/JUDGE.md).
- **Calibration sets are ours** (n=80 AUP / n=30 friction, JP+EN). If your topics
  differ systematically, re-run and re-threshold — that's why the harness is in the box.
- **AUP threshold (0.6) is fixed by spec.** The category list and rationale:
  [AUP.md](AUP.md).

## FAQ

**Is this a jailbreak?** No. It routes lawful-but-frictional content to uncensored
models and refuses illegal categories before any model runs. The refusal layer cannot
be configured away.

**Why not just use OpenRouter's uncensored models?** Cheaper and zero-ops, and fine for
many. You lose per-turn friction escalation, the illegal-category gate, budget
guarantees, and prompt locality — those are what this repo ships.

**What does a session cost?** ~$0.6 for a 30-min warm brainstorm on the 32B backend
($1.22/hr, scale-to-zero, $0 idle) plus ~$0.00002/turn for the judge.

**Can the judge run fully offline?** Yes — llama.cpp + Kev-4B on CPU, verified AUP
25/25, $0, zero egress. Friction detection is thinner there; recommended split:
AUP local, friction hosted. Details and build steps: [docs/JUDGE.md](docs/JUDGE.md).

**My agent's tool-carrying requests crash against vLLM.** Enable
`ENABLE_AUTO_TOOL_CHOICE` + the right `TOOL_CALL_PARSER` (hermes for Qwen/ChatML,
mistral for Mistral-native templates) — recipes in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**Will you ship an MCP server?** Planned but deliberately out of the first release:
host models reshape tool results, which reintroduces a second censorship layer. The
OpenAI-compatible core avoids that. Open an issue if you need MCP — it's a thin
wrapper and will be prioritized on demand. Details: [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentation

- [AUP.md](AUP.md) — content policy, blocked categories, why the threshold is fixed
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — backend recipes, cold starts, tool parsers
- [docs/JUDGE.md](docs/JUDGE.md) — judge options (Jev / logprob / local CPU), calibration of each
- [docs/CALIBRATION.md](docs/CALIBRATION.md) — batteries, raw results, how to re-run
- [docs/GOVERNOR.md](docs/GOVERNOR.md) — budget monitoring, auto-throttle, RunPod billing quirks
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's planned (MCP adapter, npm package) and why the order

## License & contributions

Code: [Apache-2.0](LICENSE). Use: **lawful use only** per [AUP.md](AUP.md).
Issues welcome — especially calibration items (frictional-but-lawful topics that
misroute either way) and backend recipes for GPUs we haven't measured.
