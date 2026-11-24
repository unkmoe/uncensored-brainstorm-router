# The judge: options, setup, and measured quality

The judge answers two questions per user turn, in **one classify call**:

- **friction** (choice low/high): *"Will a mainstream safety-aligned assistant refuse
  this, or answer it in a noticeably narrowed way?"* — ≥ 0.2 → route to the uncensored
  backend.
- **AUP** (bool): *"Does the request involve illegal content categories?"* — ≥ 0.6 →
  refuse without calling any model. **AUP overrides everything**, including the
  explicit `uncensored:` tag (a tag skips the friction question, never the AUP one).

The prompt texts live in `pi-extensions/brainstorm-router.ts` (`jevJudge`) and are
reproduced byte-identical in the calibration harnesses. If you change one, change both.

## Option 1 — Jev via OpenCode (default)

- Provider: `opencode` classifier `jev-1.13`, authenticated with `OPENCODE_API_KEY`
  plus **prepaid OpenCode credits** (~$0.042/Mtok, input-only billing).
- **Use the paid variant.** `jev-1.13-free` requires opting in to "free endpoints that
  train on request data" and returns 400 otherwise — don't, since judge payloads are
  exactly the sensitive texts you care about. The paid variant does not train.
- Cost at our battery sizes: **~$0.00002 per judgment** (~512 tokens/call);
  1,000 turns ≈ $0.02.
- Latency: **p50 253 ms** (max 663 ms).
- Wire format: System One (typed `choice`/`bool` questions with probabilities).
  The core implements it directly over HTTP (`src/core/jev.ts`) so it runs outside pi.

## Option 2 — vLLM logprob judge (fallback, zero extra accounts)

If Jev is unavailable (no credits, network, etc.) the router degrades to a judge built
from **real next-token logprobs** on your own uncensored endpoint (`max_tokens: 1`,
label softmax). Latency 750–900 ms warm; effectively free GPU-seconds.

Measured quality — know what you're getting into:

| Judgment | Jev (`jev-1.13`) | 7B logprob judge |
| --- | --- | --- |
| friction (n=30) | 13/15 detected, **0/15 false positives** | **0/15** — non-functional |
| AUP (n=25) | 25/25 | 9/10 detected, 3 false positives |

The 7B collapse is a capability limit, not a threshold problem: small models cannot
perform the meta-judgment "would *another* model refuse this" and regress to
"could *I* answer this". Friction detection effectively requires Jev (or a
comparably capable decision model); AUP works acceptably on the fallback.

## Option 3 — fully local CPU judge (zero egress, $0)

llama.cpp (v1.0.0+, `/v1/systemone` support) + a decision-model GGUF on CPU only.
Verified end to end on a 12-core / 11 GB RAM mini-PC:

- **Model: `ggml-org/Kev-4B-GGUF`** (Apache-2.0; base Qwen3.5-4B, also Apache-2.0).
  Do **not** use OpenJev GGUFs — they are CC BY-NC 4.0 (non-commercial only).
- Build (CPU-only; the UI-assets target needs a dummy-file workaround):

  ```bash
  git clone --depth 1 --branch v1.0.0 https://github.com/ggml-org/llama.cpp
  cd llama.cpp
  cmake -B build -DGGML_NATIVE=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
        -DGGML_OPENMP=ON -DLLAMA_BUILD_UI=OFF
  # UI is unconditionally linked in v1.0.0: create dummy files if that build fails:
  #   mkdir -p build/tools/ui/dist && touch build/tools/ui/dist/{bundle-dummy.js,bundle-dummy.css,workbox-dummy.js}
  cmake --build build --target llama-server -j 10
  ```

- The server speaks the same System One wire format as Jev → point the core at it
  with `JEV_BASE_URL=http://127.0.0.1:<port>` and `JEV_MODEL=<model>`; the
  calibration harness runs unchanged.

Measured (same 55-item battery, `calibration/results/local-kev-4b-*.jsonl`):

| Judgment | Jev | Kev-4B local |
| --- | --- | --- |
| friction | 13/15 @ 0.2 | 15/15 @ **0.336** — but margin is only 0.042 (fragile on unseen data) |
| AUP | 25/25 @ 0.6 | **25/25 @ 0.648** |
| latency | p50 253 ms | p50 2.3 s (AUP-only ~1.3 s) |
| cost / egress | ~$0.00002, data leaves to judge provider | **$0, nothing leaves the machine** |

**Recommended split for the privacy-conscious:** run the AUP question on the local
judge (its false-negative behavior is the strong side) and keep friction on hosted Jev
(margin too thin locally). Both options implement the identical prompts, so this is a
deployment choice, not a code change.

## Why the AUP threshold is 0.6 (and why you can't change it)

From the 80-item battery (`calibration/aup.yaml` + `aup-expanded.yaml`):

- Violations (n=50): **all detected**, minimum probability **0.85**.
- Clean hard-negatives (n=30): one item landed at exactly **0.500** — a knife's-edge
  false positive at the old 0.5 threshold; the rest ≤ 0.50.
- Full separation therefore holds across **0.55–0.8**; the spec picks **0.6**
  (clean-side margin 0.10, violation-side margin 0.25).

Because the gate is a product-safety guarantee (it is what keeps GPU accounts from
being frozen), the threshold is fixed in source (`AUP_THRESHOLD`) and intentionally
not exposed as configuration. Changing it is a spec decision, not a tuning knob —
bring calibration data if you want to argue for a different value.
