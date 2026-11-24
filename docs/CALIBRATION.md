# Calibration: batteries, raw results, and how to re-run

Every threshold in this package is derived from batteries whose raw JSONL results are
checked in under `calibration/results/`. Nothing here is hand-waved.

## Test sets

| File | Items | Purpose |
| --- | --- | --- |
| `calibration/friction.yaml` | 30 (15 low / 15 high) | high = lawful topics mainstream models hedge on (sharp institutional critique, taboo thought experiments, devil's-advocate asks, JP-dominant with some EN) |
| `calibration/aup.yaml` | 25 (10 violations / 15 clean hard-negatives) | violations use abstracted `[違法例示: …]` placeholders, never real synthesis detail; clean side deliberately includes adult fiction, violent fiction, crime sociology — the false-positive cases that matter |
| `calibration/aup-expanded.yaml` | 55 (+40 violations / +15 hard-negatives) | the expansion that fixed the AUP threshold at 0.6 |

Violation samples are written as *category examples*, not operational content — the
point is to measure the judge, and the raw files show the exact wording tested.

## Headline results (Jev `jev-1.13`, 2026-11)

### Friction (n=30, threshold 0.2)

| Metric | Value |
| --- | --- |
| High items detected | **13/15** (misses at 0.2: two "multi-perspective / educational framing" items at 0.16 and 0.10) |
| False positives on low items | **0/15** (all lows scored 0.000) |
| Latency | p50 253 ms / max 663 ms |
| Cost | ~$0.001 for the whole 55-call battery (friction n=30 + AUP n=25 combined; see below) |

### AUP (n=80 combined, threshold 0.6)

| Metric | Value |
| --- | --- |
| Violations detected | **50/50** (min probability 0.88) |
| Clean false positives | **1/30 at 0.6** (one hard negative at 0.63) |
| Separation band | (0.630, 0.880) — 0.7-0.8 give accuracy 1.000 |

Numbers updated 2026-11-24 after the AUP prompt was fixed to include the fifth
category (controlled substances/explosives — previously missing from the Jev
prompt while present in the logprob fallback). Raw results:
`calibration/results/analysis-aup-expanded.md`.

### Judge comparison (same batteries)

| Judge | friction | AUP | latency | cost | egress |
| --- | --- | --- | --- | --- | --- |
| Jev `jev-1.13` | 13/15 @ 0.2, FP 0 | 25/25 @ 0.6 | p50 253 ms | ~$0.00002 | to judge provider |
| 7B vLLM logprob | **0/15 (non-functional)** | 9/10, FP 3 | 750-900 ms | GPU seconds | none (your endpoint) |
| Kev-4B local CPU | 15/15 @ 0.336 (margin 0.042 — fragile) | 25/25 @ 0.648 | p50 2.3 s | $0 | none |

## How to re-run

Harnesses are pi extensions, resume-aware (successful ids are skipped on re-run, so
re-execution doesn't double-bill), budget-guarded, and byte-identical to production
prompt strings:

```bash
# Jev battery (needs OPENCODE_API_KEY with credits)
pi -e ./calibration/harness-jev.ts --model calib/jev -p run --no-session

# Local Kev-4B battery (needs llama-server with the GGUF, see docs/JUDGE.md)
pi -e ./calibration/harness-local.ts --model calib/local -p run --no-session

# 7B logprob fallback battery (needs RUNPOD_API_KEY)
#   see calibration/harness.ts

# Analysis (confusion matrices at multiple thresholds, cost totals)
npx tsx calibration/analyze-jev.ts
npx tsx calibration/analyze-local.ts
npx tsx calibration/analyze-jev.ts --expanded   # AUP 80-item combined
```

Outputs land in `calibration/results/*.jsonl` (per-item probabilities, latencies,
usage) and `calibration/results/analysis-*.md`.

## Re-calibrating for your own topics

The checked-in sets encode *our* friction profile (Japanese brainstorming about
institutions, history, policy). If your usage differs:

1. Add 15-30 labeled items to (copies of) the YAML files — keep the abstracted
   violation format, keep hard-negatives on the clean side.
2. Run the harness, read the threshold sweep in the analysis output.
3. Pick the threshold with zero false negatives first (AUP) and zero false
   positives second (friction), then open an issue with your numbers if the
   shipped defaults look wrong for a broad audience.

## Quality checks in the box

- `calibration/detect-simplified.ts` — simplified-Chinese contamination detector for
  JP outputs (uses a simplified-only glyph set; an earlier naive set false-flagged
  common kanji — fixed and self-tested).
- Judge probe: `pi -e ./pi-extensions/judge-probe.ts --model probe/judge -p probe`
  verifies judge availability and exact probability behavior without billing any
  chat model.
