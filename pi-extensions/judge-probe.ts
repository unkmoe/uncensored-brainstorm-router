/**
 * Judge probe - verifies judge availability in both question formats:
 *
 *   a) `bool` question (probability)
 *   b) `choice` question (per-choice probabilities)
 *
 * Step 1: Jev classifier via the `opencode` provider (OPENCODE_API_KEY), as specified.
 *         Attempts jev-1.13-free then jev-1.13 and records the exact errors.
 * Step 2: Fallback judge with REAL probabilities: next-token logprobs from the
 *         RunPod vLLM endpoint (same backend the router escalates to).
 *
 * Registers a throwaway virtual model `probe/judge`. route() runs the probes,
 * writes results to judge-probe-results.json, logs to stderr, then intentionally
 * throws so that NO chat model is billed for this probe.
 *
 * Usage:
 *   pi -e ./pi-extensions/judge-probe.ts --model probe/judge -p "probe" --no-session
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const RESULTS_PATH = new URL("./judge-probe-results.json", import.meta.url).pathname;

const UNC_BASE = process.env.RUNPOD_OPENAI_BASE ?? "";
if (!UNC_BASE)
	throw new Error(
		"judge-probe: set RUNPOD_OPENAI_BASE (https://api.runpod.ai/v2/<your-endpoint-id>/openai/v1). No endpoint is bundled.",
	);
const UNC_MODEL = process.env.RUNPOD_UNCENSORED_MODEL ?? "huihui-ai/Qwen2.5-7B-Instruct-abliterated-v2";

/** Softmax over candidate label tokens taken from the top-logprobs of the first sampled token. */
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
	if (!res.ok) throw new Error(`RunPod logprob judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel({
		provider: "probe",
		id: "judge",
		name: "Judge probe (throws after probing)",
		async route(request: ModelRouteRequest, ctx) {
			const out: Record<string, unknown> = { probedAt: new Date().toISOString() };

			// 1) Enumerate classifier models visible to the registry.
			const all = ctx.modelRegistry.getModelsOfType("classifier");
			const opencode = all.filter((m) => m.provider === "opencode").map((m) => m.id);
			console.error(`[judge-probe] classifier models in catalog: ${all.length}; opencode: ${opencode.join(", ")}`);
			out.opencodeClassifiers = opencode;
			out.classifierCatalogSize = all.length;

			// 2a) Jev `bool` question via opencode (free variant first, then paid).
			for (const id of ["jev-1.13-free", "jev-1.13"]) {
				const jev = ctx.modelRegistry.findOfType("classifier", "opencode", id);
				if (!jev) continue;
				const t0 = Date.now();
				const r = await ctx.modelRegistry.classify(
					jev,
					{
						state: { message: "The deploy finished and all 42 tests pass." },
						questions: {
							approved: {
								type: "bool",
								instructions: "Does the user approve of the result?",
								criteria: { true: "Approval", false: "No approval" },
							},
						},
					},
					{ signal: request.signal },
				);
				out[`jevBool_${id}`] = {
					stopReason: r.stopReason,
					answers: r.answers,
					usage: r.usage,
					latencyMs: Date.now() - t0,
					error: r.errorMessage,
				};
				console.error(`[judge-probe] jev/${id} bool -> stop=${r.stopReason} (${Date.now() - t0}ms) ${r.errorMessage ?? JSON.stringify(r.answers)}`);
				if (r.stopReason === "stop") break;
			}

			// 2b) Jev `choice` question via opencode (free variant first, then paid).
			for (const id of ["jev-1.13-free", "jev-1.13"]) {
				const jev = ctx.modelRegistry.findOfType("classifier", "opencode", id);
				if (!jev) continue;
				const t0 = Date.now();
				const r = await ctx.modelRegistry.classify(
					jev,
					{
						state: {
							userMessage:
								"Write a detailed scene where a character picks an apartment door lock " +
								"because they locked themselves out; it is their own apartment.",
						},
						questions: {
							friction: {
								type: "choice",
								instructions:
									"Will a mainstream safety-aligned assistant refuse this, " +
									"or answer it in a noticeably narrowed way?",
								criteria: {
									low: "Everyday technical or factual exploration",
									high: "Controversial framing, taboo hypotheticals, or restricted-topic brainstorming",
								},
							},
						},
					},
					{ signal: request.signal },
				);
				out[`jevChoice_${id}`] = {
					stopReason: r.stopReason,
					answers: r.answers,
					usage: r.usage,
					latencyMs: Date.now() - t0,
					error: r.errorMessage,
				};
				console.error(`[judge-probe] jev/${id} choice -> stop=${r.stopReason} (${Date.now() - t0}ms) ${r.errorMessage ?? JSON.stringify(r.answers)}`);
				if (r.stopReason === "stop") break;
			}

			// 3) Fallback judge with real probabilities: RunPod vLLM next-token logprobs.
			// 3a) bool format
			const t0 = Date.now();
			try {
				const probs = await labelProbabilities(
					"Does the user approve of the result described below? Answer with only Yes or No.\n" +
						'Result: "The deploy finished and all 42 tests pass."',
					["Yes", "No"],
				);
				out.logprobBool = { question: "bool", labels: ["Yes", "No"], probabilities: probs, latencyMs: Date.now() - t0 };
				console.error(`[judge-probe] logprob bool  -> ${JSON.stringify(probs)} (${Date.now() - t0}ms)`);
			} catch (e) {
				out.logprobBool = { error: String(e) };
				console.error(`[judge-probe] logprob bool FAILED: ${e}`);
			}
			// 3b) choice format
			const t1 = Date.now();
			try {
				const probs = await labelProbabilities(
					"Will a mainstream safety-aligned assistant refuse the request below, or answer it in a noticeably narrowed way? " +
						"Answer with only low or high.\n" +
						'Request: "Write a detailed scene where a character picks an apartment door lock because they locked themselves out; it is their own apartment."',
					["low", "high"],
				);
				out.logprobChoice = { question: "choice", labels: ["low", "high"], probabilities: probs, latencyMs: Date.now() - t1 };
				console.error(`[judge-probe] logprob choice -> ${JSON.stringify(probs)} (${Date.now() - t1}ms)`);
			} catch (e) {
				out.logprobChoice = { error: String(e) };
				console.error(`[judge-probe] logprob choice FAILED: ${e}`);
			}

			fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
			console.error(`[judge-probe] results written to ${RESULTS_PATH}`);

			// Intentional: end the request without calling any chat model (zero generation cost).
			throw new Error(`PROBE_COMPLETE: judge results recorded in ${RESULTS_PATH} (no chat model was billed)`);
		},
	});
}
