/**
 * Shared configuration for the OpenAI-compatible HTTP core (doc/10 Phase 3 Wave 1).
 *
 * Thresholds are the calibrated values from worker-reports/p2-jevcal.md
 * (friction 0.2: 13/15 detected, FPR 0/15; AUP 0.5: 25/25 correct) and MUST
 * match pi-extensions/brainstorm-router.ts.
 */

/** doc/09 §4: refuse at >= 0.5 (Jev calibration: 25/25 correct at 0.5). */
export const AUP_THRESHOLD = 0.5;
/** Jev calibration 2026-11-24: 13/15 detected, FPR 0/15 at 0.2. */
export const FRICTION_THRESHOLD = 0.2;

/** RunPod 24B OpenAI-compatible endpoint (main axis, p2-24b.md). */
export const UNC_BASE =
	process.env.RUNPOD_OPENAI_BASE ?? "https://api.runpod.ai/v2/YOUR_ENDPOINT_ID/openai/v1";
export const UNC_MODEL =
	process.env.RUNPOD_UNCENSORED_MODEL ?? "dphn/Dolphin-Mistral-24B-Venice-Edition";

/** Server listen settings. */
export const PORT = Number(process.env.CORE_PORT ?? 8787);
export const HOST = process.env.CORE_HOST ?? "127.0.0.1";

/** Budget floor (USD). Warn at startup when the RunPod balance is below this. */
export const BALANCE_FLOOR = Number(process.env.BALANCE_FLOOR ?? "1.00");

/** Judge backend selection: jev | vllm | auto (default auto, same as the router). */
export type JudgeMode = "jev" | "vllm" | "auto";
export const JUDGE_MODE: JudgeMode =
	((process.env.CORE_JUDGE_MODE ?? "auto") as JudgeMode) ?? "auto";

/** Max accepted request body size (chat messages can be long, but not unbounded). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function log(msg: string): void {
	console.error(`[core] ${new Date().toISOString()} ${msg}`);
}

export function num(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}
