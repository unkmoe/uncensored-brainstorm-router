# uncensored-brainstorm-router

A pi extension that removes alignment friction from brainstorming.

Every user turn — including mundane ones — is classified once first
(friction + legality, ~250 ms). The turn then goes to your normal session model,
to an uncensored RunPod backend, or — for illegal categories — to a hard refusal
where no response model is called:

```
your message
    │
    ▼
judge — one classify call per turn
    │
    ├─ AUP ≥ 0.6       ──►  refused — no response model is called
    ├─ friction ≥ 0.2  ──►  uncensored backend
    └─ otherwise       ──►  your normal session model
```

- **AUP (Acceptable Use Policy) ≥ 0.6** — the judge's probability that the request
  belongs to an illegal content category. Fixed by spec ([AUP.md](AUP.md)); at or
  above it, the turn is refused — no response model is called.
- **friction ≥ 0.2** — the judge's probability that a mainstream assistant would
  refuse or dilute this request. At or above it, the turn is served by the
  uncensored backend instead.
- An explicit `uncensored:` tag takes the friction branch directly — the AUP
  check runs either way (see FAQ for the judge-unavailable case).

## Prerequisites

The default setup this README assumes:

- **pi** — this package is a pi extension (`pi -e …`; verified with pi 1.5.x).
  Other clients are outside this README's scope, and a normal session model must
  be configured — mundane turns go to it.
- **Node.js 20+** — runs the extension and the bundled tooling (`npm install`).
- **RunPod account (prepaid)** — hosts the uncensored backend. Create an API key
  in the console (Settings → API Keys) with serverless management and billing read.
- **OpenCode account with prepaid credits** — powers the default judge: Jev
  (`jev-1.13`), a decision model for typed judgments. The judge receives your
  message text on every turn; the paid variant does not train on it, while the
  free variant requires a training opt-in and is not recommended. To keep turns
  fully on your machine, a local CPU judge is available
  ([docs/JUDGE.md](docs/JUDGE.md)).
- **An OpenAI-compatible uncensored endpoint** on RunPod serverless — default
  recipe: Qwen2.5-32B-Instruct-abliterated fp8 × A40 (copy-paste JSON in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

Non-default judge alternatives (fully local CPU judge, logprob fallback) are
documented in [docs/JUDGE.md](docs/JUDGE.md).

## Quick start

Deploy the backend first: follow a recipe in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), create the endpoint, and note the
endpoint ID it returns. Then:

```bash
git clone https://github.com/unkmoe/uncensored-brainstorm-router.git && cd uncensored-brainstorm-router && npm install

export RUNPOD_API_KEY=rpa_…        # Prerequisites: RunPod
export OPENCODE_API_KEY=…          # Prerequisites: judge (Jev)
export RUNPOD_OPENAI_BASE="https://api.runpod.ai/v2/YOUR_ENDPOINT_ID/openai/v1"
export RUNPOD_UNCENSORED_MODEL=huihui-ai/Qwen2.5-32B-Instruct-abliterated
# export BRAINSTORM_JUDGE=auto     # jev | vllm | auto (default: auto)

pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm
```

> `RUNPOD_OPENAI_BASE` is **required** — no endpoint is bundled in this repo, and
> the router and the core fail fast with a clear message when it is unset. If your
> backend is unreachable later, the AUP gate still runs judge-side; only the
> uncensored route is unavailable.

Then just talk. No tag is required — the judge escalates frictional-but-lawful
topics on its own. Prefix a message with `uncensored:` to force the uncensored
route (the AUP check still applies); illegal categories are refused outright.
Every decision — probabilities, latency, route — is logged to stderr, never your
API keys.

To make it permanent, copy `pi-extensions/brainstorm-router.ts` to
`~/.pi/agent/extensions/brainstorm-router/index.ts`; the router then appears as
`router/brainstorm` in `/model` for every session.

## Commands

| Command | Purpose |
| --- | --- |
| `pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm` | The router (this README's subject) |
| `npm run smoke` | Read-only RunPod connectivity check |
| `npm run governor -- --config governor.config.example.json` | Budget monitor — omit `--apply` to watch only; add it to auto-throttle when limits are exceeded |

## Limitations

- The judge's thresholds are calibrated on our topics (JP-heavy brainstorming;
  n=30 friction / n=80 AUP) — re-calibrate for yours with the bundled harness:
  [docs/CALIBRATION.md](docs/CALIBRATION.md).
- The AUP threshold is fixed by spec — not a configuration option
  ([AUP.md](AUP.md)).

## FAQ

**What does it cost?** The backend bills per second of worker uptime on RunPod
(~$1.22/hr on the default recipe). Scale-to-zero makes idle free, but each
warm-down waits ~300 s first, which is billed (≈$0.11); a warm 30-minute session
runs about $0.6. The judge adds ~$0.00002 per turn on Jev, or
nothing with the local judge. Budget caps and monitoring:
[docs/GOVERNOR.md](docs/GOVERNOR.md).

**What if the judge is unavailable?** The router falls back to a logprob judge —
built from your own backend's word probabilities with a one-token call: AUP
refusals keep working, automatic friction escalation does not (an explicit
`uncensored:` still forces the route). A fully local CPU judge is also
available — [docs/JUDGE.md](docs/JUDGE.md).

## Documentation

- [AUP.md](AUP.md) — content policy and the fixed threshold
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — backend recipes, cold starts, tool parsers, RunPod key pitfalls
- [docs/JUDGE.md](docs/JUDGE.md) — Jev / logprob fallback / local CPU judge
- [docs/CALIBRATION.md](docs/CALIBRATION.md) — batteries, results, how to re-run
- [docs/GOVERNOR.md](docs/GOVERNOR.md) — budget monitoring and RunPod billing quirks
- [docs/ROADMAP.md](docs/ROADMAP.md) — layout, philosophy, deferred items (MCP, npm)

## License

[Apache-2.0](LICENSE) · **lawful use only** per [AUP.md](AUP.md). Backend recipes
and feedback welcome via
[issues](https://github.com/unkmoe/uncensored-brainstorm-router/issues).
