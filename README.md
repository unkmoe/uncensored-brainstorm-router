# uncensored-brainstorm-router

A pi extension that removes alignment friction from brainstorming.

Every user turn is classified once (friction + legality, ~250 ms). The turn then goes
to your normal session model, to an uncensored RunPod backend, or — for illegal
categories — to a hard refusal with **no model called at all**:

```
your message
    │
    ▼
judge — one classify call per turn
    │
    ├─ AUP ≥ 0.6       ──►  refused — no model is called
    ├─ friction ≥ 0.2  ──►  uncensored backend
    └─ otherwise       ──►  your normal session model
```

- **AUP ≥ 0.6** — the judge's probability that the request belongs to an illegal
  content category. Fixed by spec ([AUP.md](AUP.md)); above it, no model is called
  and no GPU time is billed.
- **friction ≥ 0.2** — the judge's probability that a mainstream assistant would
  refuse or dilute this request. Above it, the turn is served by the uncensored
  backend instead.

## Prerequisites

The default setup this README assumes:

- **pi** — this package is a pi extension (`pi -e …`). Other clients are outside
  this README's scope.
- **Node.js 20+** — runs the extension and the bundled tooling (`npm install`).
- **RunPod account (prepaid)** — hosts the uncensored backend. Create an API key
  in the console (Settings → API Keys) with serverless management, billing read,
  and **AI API access granted per endpoint in the console** (no REST way to grant
  it — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- **OpenCode account with prepaid credits** — powers the default judge
  (`jev-1.13`). The free judge variant requires a training
  opt-in and is not recommended ([docs/JUDGE.md](docs/JUDGE.md)).
- **An OpenAI-compatible uncensored endpoint** on RunPod serverless — default
  recipe: Qwen2.5-32B-Instruct-abliterated fp8 × A40 (copy-paste JSON in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

Non-default judge alternatives (fully local CPU judge, logprob fallback) are
documented in [docs/JUDGE.md](docs/JUDGE.md).

## Quick start

With the Prerequisites in hand:

```bash
git clone <repo-url> && cd uncensored-brainstorm-router && npm install

export RUNPOD_API_KEY=rpa_…        # Prerequisites: RunPod
export OPENCODE_API_KEY=…          # Prerequisites: judge (Jev)
export RUNPOD_OPENAI_BASE=https://api.runpod.ai/v2/<endpoint-id>/openai/v1
export RUNPOD_UNCENSORED_MODEL=huihui-ai/Qwen2.5-32B-Instruct-abliterated

pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm
```

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
| `npm run governor -- --config <file>` | Budget monitor (session/day/month caps, optional `--apply` auto-throttle) |

## Limitations

- Tool-call behavior is a property of the backend model, not of the router — the
  default backend fires them reliably; the alternative is chat-only. Details and
  parser recipes: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- The judge's thresholds are calibrated on our topics — re-calibrate for yours
  with the bundled harness: [docs/CALIBRATION.md](docs/CALIBRATION.md).
- **The AUP threshold is fixed by spec** — not a configuration option
  ([AUP.md](AUP.md)).

## FAQ

**What does it cost?** The backend bills per second of worker uptime on RunPod
(~$1.22/hr on the default recipe; $0 while idle — scale-to-zero), so a warm
30-minute session runs about $0.6. The judge adds ~$0.00002 per turn on Jev, or
nothing with the local judge. Budget caps and monitoring:
[docs/GOVERNOR.md](docs/GOVERNOR.md).

**What if the judge is unavailable?** The router falls back to a logprob judge on
your own backend: AUP refusals keep working, automatic friction escalation does
not (an explicit `uncensored:` still forces the route). A fully local CPU judge
is also available — [docs/JUDGE.md](docs/JUDGE.md).

## Documentation

- [AUP.md](AUP.md) — content policy and the fixed threshold
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — backend recipes, cold starts, tool parsers, RunPod key pitfalls
- [docs/JUDGE.md](docs/JUDGE.md) — Jev / logprob fallback / local CPU judge
- [docs/CALIBRATION.md](docs/CALIBRATION.md) — batteries, results, how to re-run
- [docs/GOVERNOR.md](docs/GOVERNOR.md) — budget monitoring and RunPod billing quirks
- [docs/ROADMAP.md](docs/ROADMAP.md) — layout, philosophy, deferred items (MCP, npm)

## License

[Apache-2.0](LICENSE) · **lawful use only** per [AUP.md](AUP.md). Backend recipes
and feedback welcome via issues.
