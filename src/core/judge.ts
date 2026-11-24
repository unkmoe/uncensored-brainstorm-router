/**
 * Dual-question judge, centralized for the HTTP core (doc/09 §2-4).
 *
 * Backend 1: Jev (jev-1.13) via direct System One HTTP (jev.ts) — preferred.
 * Backend 2: real next-token logprobs from the RunPod vLLM endpoint — fallback
 * when Jev errors (billing, network, malformed answers).
 *
 * Prompt wording is copied VERBATIM from pi-extensions/brainstorm-router.ts
 * (jevJudge / vllmJudge). Do not edit: the calibrated thresholds
 * (friction 0.2 / AUP 0.5, worker-reports/p2-jevcal.md) correspond to these
 * exact prompts.
 */

import { UNC_BASE, UNC_MODEL, JUDGE_MODE, log, type JudgeMode } from "./config.js";
import { jevClassifyDual } from "./jev.js";
import type { JevUsage } from "./jev.js";

// --- Router prompt wording (verbatim) --------------------------------------

const FRICTION_INSTRUCTIONS =
	"Will a mainstream safety-aligned assistant refuse this, " +
	"or answer it in a noticeably narrowed way?";
const FRICTION_CRITERIA = {
	low: "Everyday technical or factual exploration",
	high: "Controversial framing, taboo hypotheticals, or restricted-topic brainstorming",
} as const;

const AUP_INSTRUCTIONS =
	"Does this request involve illegal content categories " +
	"(e.g., sexual content involving minors, instructions for serious violence or " +
	"weapons of mass harm, fraud, unauthorized intrusion)? " +
	"Judge the request itself, not how objectionable the topic sounds.";
const AUP_CRITERIA = { true: "Illegal category present", false: "No illegal category" } as const;

// --- Outcome ----------------------------------------------------------------

export type JudgeBackend = "jev" | "vllm-logprobs";

export interface JudgeOutcome {
	backend: JudgeBackend;
	/** P(friction = high) */
	frictionHigh: number;
	/** P(aup = true) */
	aup: number;
	latencyMs: number;
	/** Jev token usage when backend === "jev" (vLLM fallback reports none). */
	usage?: JevUsage | undefined;
}

// --- Backend 1: Jev via direct System One HTTP ------------------------------

async function jevJudge(text: string): Promise<JudgeOutcome> {
	const t0 = Date.now();
	// doc/09 §2: both questions in ONE classify call (marginal cost ~zero).
	const answer = await jevClassifyDual(text, {
		friction: {
			type: "choice",
			instructions: FRICTION_INSTRUCTIONS,
			criteria: { ...FRICTION_CRITERIA },
		},
		aup: {
			type: "noul", // wire-level name for the router's public `bool` question
			instructions: AUP_INSTRUCTIONS,
			criteria: { ...AUP_CRITERIA },
		},
	});
	return {
		backend: "jev",
		frictionHigh: answer.frictionHigh,
		aup: answer.aup,
		latencyMs: Date.now() - t0,
		...(answer.usage !== undefined ? { usage: answer.usage } : {}),
	};
}

// --- Backend 2: vLLM next-token logprobs (verbatim from the router) -----------

async function labelProbabilities(prompt: string, labels: string[]): Promise<Record<string, number>> {
	const res = await fetch(`${UNC_BASE.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: UNC_MODEL,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 1,
			temperature: 0,
			logprobs: true,
			top_logprobs: 20,
		}),
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok) throw new Error(`RunPod logprob judge HTTP ${res.status}`);
	const body = (await res.json()) as {
		choices?: Array<{ logprobs?: { content?: Array<{ top_logprobs?: Array<{ token: string; logprob: number }> }> } }>;
	};
	const tops = body.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
	const labelLogprobs = labels.map((label) => {
		const matches = tops.filter((t) => t.token.trim() === label).map((t) => t.logprob);
		return { label, logprob: matches.length ? Math.max(...matches) : -Infinity };
	});
	const max = Math.max(...labelLogprobs.map((l) => l.logprob));
	const exp = labelLogprobs.map((l) => ({ ...l, e: l.logprob === -Infinity ? 0 : Math.exp(l.logprob - max) }));
	const sum = exp.reduce((acc, l) => acc + l.e, 0);
	return Object.fromEntries(exp.map((l) => [l.label, l.e / sum]));
}

async function vllmJudge(text: string): Promise<JudgeOutcome> {
	const truncated = text.slice(0, 8_000);
	const t0 = Date.now();
	const [friction, aup] = await Promise.all([
		labelProbabilities(
			"A user sends the following request to an AI assistant. Would a typical mainstream safety-aligned " +
				"assistant (like Claude or ChatGPT) refuse the request, or answer it in a noticeably narrowed, " +
				"self-censored way? Judge the topic area and framing of the request itself. " +
				"Answer with only Yes or No.\n" +
				`request: ${JSON.stringify(truncated)}`,
			["Yes", "No"],
		),
		labelProbabilities(
			"You are the automated safety layer of an AI service. The following categories are forbidden: " +
				"sexual content involving minors; instructions for serious violence or weapons of mass harm; " +
				"instructions for synthesizing controlled substances or explosives; fraud; unauthorized intrusion " +
				"into computer systems. Does the user request below ask for content in any of these forbidden " +
				"categories? Answer Yes if it does, even partially; answer No if it is clearly lawful. " +
				"When unsure, answer Yes. Answer with only Yes or No.\n" +
				`request: ${JSON.stringify(truncated)}`,
			["Yes", "No"],
		),
	]);
	return {
		backend: "vllm-logprobs",
		frictionHigh: friction.Yes ?? 0,
		aup: aup.Yes ?? 0,
		latencyMs: Date.now() - t0,
	};
}

// --- Backend selection --------------------------------------------------------

let jevBroken = false; // auto mode: remember a failed Jev call within this process

/**
 * Runs the dual-question judge. In auto mode a Jev failure is remembered and
 * later turns go straight to the vLLM fallback (same behavior as the router).
 * Throws only when the selected backend(s) fail entirely.
 */
export async function runJudge(text: string): Promise<JudgeOutcome> {
	if (JUDGE_MODE !== "vllm" && !jevBroken) {
		if (!process.env.OPENCODE_API_KEY) {
			const msg = "OPENCODE_API_KEY is not set";
			if (JUDGE_MODE === ("jev" as JudgeMode)) throw new Error(`Jev judge unavailable: ${msg}`);
			log(`Jev judge unavailable (${msg}); falling back to vllm-logprobs`);
			jevBroken = true;
		} else {
			try {
				return await jevJudge(text);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (JUDGE_MODE === ("jev" as JudgeMode)) throw new Error(`Jev judge unavailable: ${msg}`);
				log(`Jev judge unavailable (${msg}); falling back to vllm-logprobs`);
				jevBroken = true;
			}
		}
	}
	return vllmJudge(text);
}
