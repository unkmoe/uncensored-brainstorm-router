# Acceptable Use Policy (AUP)

This package exists to remove **alignment friction on lawful material** — not to
enable illegal use. Every routed request is screened by a built-in classifier
("the judge"), and the illegal-category verdict is enforced *before any model is
called*. This document states what the judge blocks and what you may configure.

## Blocked categories

The judge refuses (no model is called) when the **request itself** — judged on its
topic and framing, not on how objectionable the subject sounds — falls into any of
the following illegal content categories. This enumeration matches the AUP prompts
embedded in this package exactly — the Jev judge prompt in
`pi-extensions/brainstorm-router.ts` (mirrored in `src/core/judge.ts` and the
calibration harnesses) and the logprob fallback prompt:

1. **Sexual content involving minors**
2. **Instructions for serious violence or weapons of mass harm**
3. **Instructions for synthesizing controlled substances or explosives**
4. **Fraud**
5. **Unauthorized intrusion into computer systems**

The judge is instructed to answer *Yes* when unsure (fail-safe), and an explicit
`uncensored:` tag does **not** bypass this check — the AUP verdict overrides every
routing decision.

## What passes

Lawful but "edgy" material is intentionally allowed through: controversial
framing, taboo hypotheticals, restricted-topic brainstorming, institutional
critique, dark fiction for adults, etc. The calibration battery (`calibration/aup.yaml`) shows
lawful adult content scoring 0.06–0.10 (well under the threshold) while illegal
categories score 0.95+ (`calibration/results/analysis-jev.md`).

## What you may and may not configure

- **Configurable:** judge backend selection, backend endpoints/models, budget
  limits.
- **Not configurable:** the **AUP threshold (0.6)**, the **friction threshold
  (0.2)**, and the **blocked-category enumeration above**. Both thresholds are
  fixed constants in the source (`AUP_THRESHOLD` / `FRICTION_THRESHOLD`) — there is
  no environment variable or CLI flag for them; changing one is a source edit plus
  a calibration re-run ([docs/CALIBRATION.md](docs/CALIBRATION.md)). Removing or
  loosening the AUP gate is out of spec for this package — the gate is the
  package's license to exist. Deployment operators are of course free to fork, but
  a build without the gate is not this project.

## Measured enforcement quality

Accuracy across the 80-item battery (2026-11-24): violations **50/50 detected** (min 0.85), one hard-negative FP at exactly 0.50 -> **threshold set to 0.6** (full separation 0.55-0.8)
(10 violation items detected at 0.950–0.990; 15 lawful items all ≤ 0.450),
with **0 false positives**. See `calibration/results/analysis-jev.md`.
