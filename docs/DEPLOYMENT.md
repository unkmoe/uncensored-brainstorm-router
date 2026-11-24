# Backend deployment recipes (RunPod serverless vLLM)

Everything here was measured on real endpoints in Nov 2026. Config JSONs are
copy-paste-ready for `POST /v2/serverless` (RunPod REST API v2, Bearer auth).

## RunPod API key pitfalls (read before your first 403)

- A key needs **three kinds of permission**: serverless management (create/list
  endpoints), billing read (governor, smoke), and **AI API access — which for
  *Restricted* keys is granted per endpoint in the console UI only**. There is no
  REST call that grants it.
- Symptom: management requests (catalog, balance, endpoint list) succeed while
  every inference-gateway call (`api.runpod.ai`) returns **403**. Fix: add your
  endpoint to the key's AI API allow-list in the console, or use a key type that
  includes AI API access.

## Default recipe — Qwen2.5-32B-Instruct-abliterated fp8 × A40

The default backend of the router. Uncensored *and* tool-call capable (the only
measured backend that is both).

```json
{
  "name": "qwen32b-abliterated",
  "type": "QUEUE",
  "image": "runpod/worker-v1-vllm:v2.32.0",
  "disk": 100,
  "env": {
    "MODEL_NAME": "huihui-ai/Qwen2.5-32B-Instruct-abliterated",
    "QUANTIZATION": "fp8",
    "MAX_MODEL_LEN": "16384",
    "GPU_MEMORY_UTILIZATION": "0.95",
    "ENABLE_PREFIX_CACHING": "true",
    "ENABLE_AUTO_TOOL_CHOICE": "true",
    "TOOL_CALL_PARSER": "hermes",
    "VLLM_STARTUP_TIMEOUT": "1800"
  },
  "gpu": { "count": 1, "pools": ["AMPERE_48"] },
  "workers": { "min": 0, "max": 1, "idleTimeout": 300, "initTimeout": 1800 },
  "scaling": { "type": "QUEUE_DELAY", "queueDelay": 4 },
  "flashboot": "FLASHBOOT",
  "timeout": 300000
}
```

Measured properties:

| Property | Value |
| --- | --- |
| License | Apache-2.0 (model and base Qwen2.5-32B-Instruct; not gated) |
| Price | **$1.22/hr** (A40 / AMPERE_48 pool), scale-to-zero → $0 idle |
| Weights | bf16 65.5 GB → fp8 ≈ 34 GB (fits 48 GB with KV cache) |
| Tool calls | **10/10 fired** on weak instructions (temp 0, valid JSON) |
| Generation | ≈ 16 tok/s |
| Friction behavior | zero refusals on lawful friction battery; no language mixing |

**`disk: 100` is not optional** — the 65.5 GB bf16 download exceeds the 50 GB
default and the worker dies with "ran out of disk during startup". fp8 quantization
happens at load, so the download is always full-size.

## Alternative recipe — Dolphin-Mistral-24B-Venice fp8 × A40

Chat-only alternative (same price, ~23 tok/s — faster generation):

```json
{
  "name": "dolphin-24b-venice",
  "type": "QUEUE",
  "image": "runpod/worker-v1-vllm:v2.32.0",
  "disk": 100,
  "env": {
    "MODEL_NAME": "dphn/Dolphin-Mistral-24B-Venice-Edition",
    "QUANTIZATION": "fp8",
    "MAX_MODEL_LEN": "16384",
    "GPU_MEMORY_UTILIZATION": "0.95",
    "ENABLE_PREFIX_CACHING": "true",
    "ENABLE_AUTO_TOOL_CHOICE": "true",
    "TOOL_CALL_PARSER": "mistral",
    "VLLM_STARTUP_TIMEOUT": "1800"
  },
  "gpu": { "count": 1, "pools": ["AMPERE_48"] },
  "workers": { "min": 0, "max": 1, "idleTimeout": 300, "initTimeout": 1800 },
  "scaling": { "type": "QUEUE_DELAY", "queueDelay": 4 },
  "flashboot": "FLASHBOOT",
  "timeout": 300000
}
```

The parser is `mistral` (not `hermes`): this model's HF chat template is
Mistral-native (`[INST]…[/INST]`, `[TOOL_CALLS]name[CALL_ID]…`), not ChatML.
Check the template of whatever model you deploy — the parser must match it.

**Do not route tool calls to this backend.** It fired 0/5 even on explicit
"you must call the tool" instructions in follow-up batteries (the single observed
firing was a freshly-booted post-PATCH worker). Text-quality is otherwise excellent
and it is Apache-2.0.

## Cold-start table (measured, 32B fp8)

| Condition | First-request latency |
| --- | --- |
| Full cold (fresh host, 65.5 GB download) | **≈ 6 min** (measured 374 s) |
| Cold with network-volume model cache | **≈ 2.5 min** (147 s, ~61% shorter) |
| FlashBoot revival (valid snapshot) | seconds–minutes (revives after 20+ min idle) |
| After any endpoint PATCH | **snapshot invalidated** — expect 1-2 full-cold requests |

Operational notes:

- A cold request that exceeds the edge proxy timeout returns a **504 to the client
  while the job keeps running server-side**; retry succeeds. Warm new endpoints with
  a one-token request first.
- Host dispersion exists inside a pool: full boots ranged 184–545 s across DCs in
  our measurements; the slow tail can eat the first queued request.
- A 7B backend's true first cold measured **106.9 s** (15 GB download).

## Network-volume model cache (optional)

Cuts the full cold to ~2.5 min for ~$0.005/hr of volume time (100 GB at $0.07/GB/mo,
only while the volume exists):

1. `POST /v2/network-volumes`
   `{"name":"model-cache","size":100,"dataCenter":"CA-MTL-1","type":"HIGH_PERFORMANCE"}`
   — the DC must match where your pool's workers actually run.
2. Mount it: `PATCH /v2/serverless/<id>` with `{"mounts":{"network":[{"volumeId":"…"}]}}`.
   Mounts land at `/runpod-volume`, which is `worker-v1-vllm`'s default `BASE_PATH`
   for the HF cache — no env changes needed.
3. One boot writes the model to the volume; later cold boots read from it.
4. To delete the volume: unmount, wait for all workers to scale down (DELETE returns
   400 while any worker still references it), then `DELETE /v2/network-volumes/<id>` (204).

## Tool-parser quick reference

| Template family | Parser env | Example models |
| --- | --- | --- |
| ChatML (`<|im_start|>`, `<tool_call>` JSON) | `hermes` | Qwen2.5/3, many abliterated Qwens |
| Mistral-native (`[INST]`, `[TOOL_CALLS]`) | `mistral` | Mistral Small fine-tunes, Dolphin-24B |

Always set both `ENABLE_AUTO_TOOL_CHOICE=true` and `TOOL_CALL_PARSER=<parser>`.
Requests merely *carrying* tool definitions crash the worker without them — that
matters because agent harnesses (pi, Claude Code) attach tools to every request.

Client-side, detect a fired call by the **`tool_calls` array, not `finish_reason`**:
the Qwen backend can emit a populated array with `finish_reason: stop` under forced
`tool_choice`, and the Dolphin backend can leak raw JSON into message content.

## Environment variables (full list)

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `RUNPOD_API_KEY` | everywhere | — | RunPod key (management + AI API) |
| `RUNPOD_OPENAI_BASE` | core, extension | `…/v2/<default-32B-endpoint>/openai/v1` | Your backend's OpenAI-compatible base |
| `RUNPOD_UNCENSORED_MODEL` | core, extension | `huihui-ai/Qwen2.5-32B-Instruct-abliterated` | Model id to force server-side |
| `CORE_PORT` / `CORE_HOST` | core | `8787` / `127.0.0.1` | HTTP core bind |
| `CORE_API_KEY` | core | unset | If set, clients must send this Bearer |
| `CORE_JUDGE_MODE` | core | `auto` | `jev` \| `vllm` \| `auto` |
| `BALANCE_FLOOR` | core | `1.00` | Startup warning threshold (USD) |
| `JEV_BASE_URL` / `JEV_MODEL` / `JEV_TIMEOUT_MS` | core | System One defaults | Judge endpoint override (e.g. local llama.cpp) |
| `OPENCODE_API_KEY` | judge | env | Jev via the opencode provider |

> The checked-in defaults in `pi-extensions/brainstorm-router.ts` and
> `src/core/config.ts` still point at the author's own endpoints — always set
> `RUNPOD_OPENAI_BASE`/`RUNPOD_UNCENSORED_MODEL` for your deployment.

## Using the core from pi (`models.json`)

With the core running on `localhost:8787` (start it with `npm run core`; see
`src/core/server.ts` for env bindings — `CORE_PORT`/`CORE_HOST`/`CORE_API_KEY`):

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

Core response headers (judge telemetry): `X-Judge-Route` (`refuse`/`uncensored`/`default`),
`X-Judge-Friction`, `X-Judge-Aup`, `X-Judge-Backend`, `X-Judge-Latency-Ms`. `uncensored`
vs `default` both point at the same backend — the label records *why* the turn was served.

Then `pi --model brainstorm-core/brainstorm …` — no extension needed; the judge and
AUP gate run inside the core. Other OpenAI-compatible clients point at the same URL,
but are not yet verified (see README Limitations).
