/**
 * Shared configuration for the OpenAI-compatible HTTP core.
 *
 * Thresholds are the calibrated values from the Jev battery
 * (raw results: calibration/results/analysis-jev.md; friction 0.2: 13/15
 * detected, FPR 0/15; AUP: 10/10 violations, full separation (0.450, 0.950))
 * and MUST match pi-extensions/brainstorm-router.ts.
 * See docs/CALIBRATION.md for the batteries and how to re-run them.
 */

/** Refuse at >= 0.6 (Jev battery: 10/10 violations, full separation (0.450, 0.950); 0.6 keeps a safety margin over the measured 0.950 violation minimum). */
export const AUP_THRESHOLD = 0.6;
/** Jev battery 2026-11: 13/15 friction-high detected, FPR 0/15 at 0.2. */
export const FRICTION_THRESHOLD = 0.2;

/**
 * RunPod OpenAI-compatible endpoint (main axis). Switched to Qwen2.5-32B-abliterated
 * (Leader decision 2026-11-24): tool_call 10/10 vs Dolphin-24B 0/5, same $1.22/hr.
 */
// No endpoint is bundled: RUNPOD_OPENAI_BASE is required (server fails fast when unset).
export const UNC_BASE = process.env.RUNPOD_OPENAI_BASE ?? "";
export const UNC_MODEL =
	process.env.RUNPOD_UNCENSORED_MODEL ?? "huihui-ai/Qwen2.5-32B-Instruct-abliterated";

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
