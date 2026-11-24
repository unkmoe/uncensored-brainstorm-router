# uncensored-brainstorm-router

A judge-based router that lets you use uncensored LLM backends **lawfully and without
alignment friction**: a lightweight dual-question classifier runs on every user turn,
then routes the turn to a mainstream model, an uncensored backend, or — for illegal
content categories — to a hard refusal without any model being called at all.

This is **not** a jailbreak project. The goal is to remove *alignment friction*
(refusals, hedging, topic-narrowing on lawful but controversial material) while
**shipping an explicit illegal-category gate in the same package**. The judge is
dual-use by design: the same classifier that escalates lawful friction also refuses
illegal categories, and the AUP threshold is **not user-configurable** (see
[AUP.md](AUP.md) — this is a spec, not an oversight).

## Measured results (2026-11-24, Jev calibration)

All numbers are from a 55-item calibration battery (`calibration/`, raw results in
`calibration/results/`, analysis in `calibration/results/analysis-jev.md`):

| Metric | Value |
| --- | --- |
| Friction detection (high items, threshold 0.2) | **13/15 detected, 0 false positives** (low items all 0.000) |
| AUP illegal-category accuracy (threshold 0.5) | **25/25** (separation band (0.450, 0.950)) |
| Judge latency | **p50 253 ms** (max 663 ms) per user turn |
| Judge cost | ~$0.00002 per judgment (~512 tokens); 1,000 turns ≈ $0.02 |
| Session cost | **~$0.6 per 30-min brainstorm session** (warm) |
| Backend | Dolphin-Mistral-24B-Venice fp8 × A40 serverless, **$1.22/hr**, FlashBoot warm-up 2.9–4.7 s |

Two question types share one classify call per user turn:

- **friction** (choice low/high): *would a mainstream safety-aligned assistant refuse
  or noticeably narrow this?* ≥ 0.2 → route to the uncensored backend.
- **AUP** (bool): *does the request involve an illegal content category?* ≥ **0.5
  (fixed)** → refuse without calling any model. AUP overrides everything, including
  an explicit `uncensored:` tag.

## What's in this repo

- `pi-extensions/brainstorm-router.ts` — pi virtual model `router/brainstorm`
  implementing the 3-branch routing above, with judge fallbacks (Jev classifier →
  real next-token logprobs from the vLLM endpoint) and full decision logging.
- `pi-extensions/judge-probe.ts` — diagnostic probe for judge availability.
- `src/` — typed RunPod API v2 client (429-aware, rate-limit headers exposed),
  budget governor (`src/governor/`, session/day/month caps with auto-throttle),
  generated API schema.
- `calibration/` — test sets (`friction.yaml` 30 items, `aup.yaml` 25 items),
  calibration harnesses, analyzers, and raw results.
- `core/` — **not included yet** (see below).

## OpenAI-compatible HTTP core (planned, being integrated)

The distribution center of this package is a small HTTP core that exposes the whole
routing stack as an ordinary OpenAI-compatible endpoint, so any agent layer
(pi, Cursor, Open WebUI, claude-code-router, …) can use it without an adapter:

```
POST /v1/chat/completions     # OpenAI-compatible request/response
                              # streaming (SSE) supported
```

The core embeds the dual-question judge, the 3-branch routing, and the budget
check; judgment logic lives in exactly one place.

### Using the core from pi (`models.json`)

Once the core is running (e.g. on `localhost:8787`), add it to your pi `models.json`
as an OpenAI-compatible provider:

```json
{
  "modelProviders": {
    "brainstorm-core": {
      "baseUrl": "http://localhost:8787/v1",
      "apiKey": "$BRAINSTORM_CORE_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "brainstorm",
          "name": "Brainstorm router (HTTP core)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 16384,
          "maxTokens": 2048
        }
      ]
    }
  }
}
```

Then run `pi --model brainstorm-core/brainstorm …` — no extension needed.

## Setup

### 1. RunPod API key

Create a key in the RunPod console (Settings → API Keys). Two permissions matter:

- **Management API** (serverless endpoint create/list, billing/balance read) —
  needed by the budget governor and `src/smoke.ts`.
- **AI API (inference gateway)** — needed to actually call your endpoints.

> **Pitfall (cost us a full debugging round):** with a *Restricted* key, AI API
> permission is granted **per endpoint in the console UI only** — there is no REST
> way to grant it. If your management calls work but every inference-gateway call
> returns **403**, this per-endpoint AI API grant is the reason. Either grant the
> endpoint permission in the console, or use a key type that includes AI API access.

Recommended scope list to tick for this project: Serverless management
(read/create endpoints), Billing read (balance), and AI API on each endpoint you
will route to.

### 2. OpenCode credits (for the Jev judge)

The default judge is **Jev** (System One classifier via the `opencode` provider).
You need an `OPENCODE_API_KEY` with **prepaid credits**. Note: the free variant
(`jev-1.13-free`) requires a training opt-in and usually 400s; the paid
`jev-1.13` works and does not train on your data (~$0.00002/judgment). Without
Jev, the router automatically falls back to a logprob judge running on your own
vLLM endpoint (`BRAINSTORM_JUDGE=vllm|jev|auto`, default `auto`).

### 3. Deploy the uncensored backend

Any OpenAI-compatible serverless vLLM endpoint works. The measured setup is
Dolphin-Mistral-24B-Venice-Edition fp8 on A40 ($1.22/hr, FlashBoot ON,
scale-to-zero — idle cost $0). Point the extension at it:

```bash
export RUNPOD_API_KEY=rpa_…                          # your key
export RUNPOD_OPENAI_BASE=https://api.runpod.ai/v2/<endpoint-id>/openai/v1
export RUNPOD_UNCENSORED_MODEL=dphn/Dolphin-Mistral-24B-Venice-Edition
export OPENCODE_API_KEY=…                            # optional; enables the Jev judge
```

(The checked-in defaults in `pi-extensions/` still point at the author's own
endpoints; always set `RUNPOD_OPENAI_BASE` for your deployment.)

### 4. Use as a pi extension

```bash
pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm
```

Every user turn is judged; decisions (probabilities, latencies, route) are logged
to stderr, never API keys. Explicit tag: start your message with `uncensored:` to
force the uncensored route (still gated by the AUP check).

### 5. Budget governor (optional but recommended)

```bash
cp governor.config.example.json governor.config.json   # edit endpoint ids + limits
npm run governor -- monitor                            # estimates accrual from live workers
npm run governor -- monitor --apply                    # auto-throttle when over budget
```

The governor watches worker count × unit price in real time (RunPod's balance API
only reflects charges after scale-down, so balance polling is not suitable for
live monitoring).

## Development

```bash
npm install
npm run typecheck
npm run build
```

Calibration harnesses run as pi extensions (see `calibration/harness-jev.ts` for
usage; they are resume-aware and budget-guarded).

## License & use policy

- Code: [Apache-2.0](LICENSE).
- Use: **lawful use only** — see [AUP.md](AUP.md). The illegal-category gate is part
  of the package; its threshold (0.5) is fixed by spec and not configurable.

## Limitations

- **Tool calls are best-effort on the uncensored backend.** Requests *carrying* tool
d  definitions no longer crash (fixed via `ENABLE_AUTO_TOOL_CHOICE` + `TOOL_CALL_PARSER=mistral`),
  but the backend actually *firing* a tool call is unreliable: the 24B Dolphin/Venice fine-tune
  was not trained for tool use, and runtime fp8 quantization degrades strict format adherence.
  For "research-then-brainstorm" workflows, have the *host* agent gather context with its own
  tools and pass the material to the backend (the recommended pattern — see the pi extension's
  delegation flow). If you need a backend that both is uncensored and calls tools reliably,
  watch for the Qwen-abliterated backend experiments; open an issue to signal demand.

## MCP adapter

**Planned.** The MCP adapter is deliberately out of wave 1 (tool-result shaping by
the host's aligned model would reintroduce a second censorship layer); the HTTP
core is the primary interface. **If you need MCP, open an issue — it's a thin
wrapper around the core and will be prioritized on request.**
