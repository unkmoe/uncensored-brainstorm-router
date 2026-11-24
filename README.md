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

## Prerequisites

The default setup this README assumes:

- **pi** — this package is a pi extension (`pi -e …`). Other clients are outside
  this README's scope.
- **Node.js 20+** — runs the extension and the bundled tooling (`npm install`).
- **RunPod account (prepaid)** — hosts the uncensored backend. Your API key needs
  serverless management, billing read, and **AI API access granted per endpoint in
  the console** (no REST way to grant it — see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- **OpenCode account with prepaid credits** — powers the default judge
  (`jev-1.13`, ~$0.00002/turn). The free judge variant requires a training
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

- Tool calls are backend-dependent (default 32B: 10/10 on weak instructions; the
  Dolphin alternative: 0/5 even on explicit instructions — chat only).
- Calibration sets are ours (JP-heavy brainstorming, n=80 AUP / n=30 friction);
  re-run the harness for your topics ([docs/CALIBRATION.md](docs/CALIBRATION.md)).
- **AUP threshold (0.6) is fixed by spec** ([AUP.md](AUP.md)).

## FAQ

**Cost per session?** ~$0.6 / 30 min warm ($1.22/hr, scale-to-zero, $0 idle) plus
~$0.00002/turn for the judge (or $0 with the local judge).

**Judge offline?** The router falls back to a logprob judge on your own endpoint.
AUP stays usable there; friction detection does not — [docs/JUDGE.md](docs/JUDGE.md).

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
