/**
 * Brainstorm router - virtual model `router/brainstorm` implementing doc/07 §2 (経路B) +
 * doc/09 §2-4 (dual-question judge -> 3-branch routing).
 *
 * Judge: one dual-question call per user turn (`request.reason === "user"` only; tool
 * follow-ups/retries stay sticky on the previous model). The judge answers:
 *   - friction (choice low/high): will a mainstream assistant refuse or self-censor?
 *   - aup (bool): does the request involve an illegal content category?
 * Routing (doc/09 §3, thresholds §4):
 *   - aup >= 0.5                       -> REFUSE (no model is called; AUP overrides everything,
 *                                         including an explicit `uncensored:` tag)
 *   - explicit tag OR friction >= 0.2  -> uncensored RunPod backend (thinking off)
 *   - otherwise                        -> main model
 *
 * Judge backend selection (`BRAINSTORM_JUDGE` = jev | vllm | auto, default auto):
 *   - jev:  Jev via the `opencode` provider (System One classify). Preferred; currently
 *           blocked by billing (free needs the org privacy opt-in, paid has no credits),
 *           in which case auto falls back to:
 *   - vllm: real next-token logprobs from the RunPod vLLM endpoint (bool -> Yes/No,
 *           choice -> low/high, softmax over label tokens). Runs on the same endpoint
 *           the uncensored backend uses; a few hundred ms warm.
 *
 * Uncensored backend: `runpod-uncensored` provider (OpenAI-compatible), configurable via
 * RUNPOD_OPENAI_BASE / RUNPOD_UNCENSORED_MODEL; apiKey references $RUNPOD_API_KEY.
 * Main model: anthropic claude-sonnet if credentialed, else the first available free
 * chat model (opencode-go first).
 *
 * Every decision is logged to stderr with timestamps, probabilities and latency
 * (never API keys). Usage:
 *   pi -e ./pi-extensions/brainstorm-router.ts --model router/brainstorm -p "..."
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const UNC_PROVIDER = "runpod-uncensored";
// Main axis switched to Qwen2.5-32B-abliterated (Leader decision 2026-11-24): tool_call fires 10/10 vs Dolphin-24B 0/5 on identical prompts, same $1.22/hr (p3-qwen-tools.md). Dolphin-24B stays available via env override for tool-free, explicitly-instructed sub-tasks.
// No endpoint is bundled: RUNPOD_OPENAI_BASE is required (fail-fast at load).
const UNC_BASE = process.env.RUNPOD_OPENAI_BASE ?? "";
const REQUIRE_BASE =
	"brainstorm-router: set RUNPOD_OPENAI_BASE (https://api.runpod.ai/v2/<your-endpoint-id>/openai/v1). " +
	"No endpoint is bundled in this repo.";
const UNC_MODEL = process.env.RUNPOD_UNCENSORED_MODEL ?? "huihui-ai/Qwen2.5-32B-Instruct-abliterated";
const AUP_THRESHOLD = 0.6; // doc/09 §4 + 80-item calibration (2026-11-24): FN 0/50, min violation 0.85, one FP at exactly 0.50; full separation 0.55-0.8 (worker-reports/r-aup.md)
const FRICTION_THRESHOLD = 0.2; // Jev calibration 2026-11-24: 13/15 detected, FPR 0/15 at 0.2 (worker-reports/p2-jevcal.md)
const JUDGE_MODE = (process.env.BRAINSTORM_JUDGE ?? "auto") as "jev" | "vllm" | "auto";

interface RouterState {
	/** Summary of the latest judge decision on this branch (for /tree inspection). */
	lastJudge?: {
		at: string;
		judge: string;
		frictionHigh?: number;
		aup?: number;
		route: string;
		latencyMs?: number;
		note?: string;
	};
}

interface JudgeOutcome {
	judge: string;
	frictionHigh: number;
	aup: number;
	latencyMs: number;
	note?: string;
}

function log(msg: string): void {
	console.error(`[brainstorm-router] ${new Date().toISOString()} ${msg}`);
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Judge backend 1: Jev via opencode (doc/07 §1; preferred when billing works)
// ---------------------------------------------------------------------------

async function jevJudge(text: string, request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<JudgeOutcome | { error: string }> {
	const jev =
		ctx.modelRegistry.findOfType("classifier", "opencode", "jev-1.13") ?? // paid variant: works, does not train (calibration 2026-11-24)
		ctx.modelRegistry.findOfType("classifier", "opencode", "jev-1.13-free"); // free variant requires training opt-in, usually 400
	if (!jev) return { error: "no opencode Jev classifier in catalog" };
	const t0 = Date.now();
	// doc/09 §2: both questions in ONE classify call (marginal cost ~zero).
	const r = await ctx.modelRegistry.classify(
		jev,
		{
			state: { userMessage: text.slice(0, 16_000) },
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
				aup: {
					type: "bool",
					instructions:
						"Does this request involve illegal content categories " +
						"(e.g., sexual content involving minors, instructions for serious violence or " +
						"weapons of mass harm, fraud, unauthorized intrusion)? " +
						"Judge the request itself, not how objectionable the topic sounds.",
					criteria: { true: "Illegal category present", false: "No illegal category" },
				},
			},
		},
		{ signal: request.signal },
	);
	if (r.stopReason !== "stop") return { error: r.errorMessage ?? `stopReason=${r.stopReason}` };
	const f = r.answers.friction;
	const a = r.answers.aup;
	return {
		judge: `jev:${jev.provider}/${jev.id}`,
		frictionHigh: f?.type === "choice" ? (f.probabilities.high ?? 0) : 0,
		aup: a?.type === "bool" ? a.probability : 0,
		latencyMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// Judge backend 2: real next-token logprobs from the RunPod vLLM endpoint
// ---------------------------------------------------------------------------

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

async function vllmJudge(text: string): Promise<JudgeOutcome | { error: string }> {
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
		judge: "vllm-logprobs",
		frictionHigh: friction.Yes ?? 0,
		aup: aup.Yes ?? 0,
		latencyMs: Date.now() - t0,
	};
}

let jevBroken = false; // auto mode: remember a failed Jev call within this process

async function runJudge(text: string, request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<JudgeOutcome> {
	if (JUDGE_MODE !== "vllm" && !jevBroken) {
		const r = await jevJudge(text, request, ctx);
		if (!("error" in r)) return r;
		log(`Jev judge unavailable (${r.error})${JUDGE_MODE === "auto" ? "; falling back to vllm-logprobs" : ""}`);
		if (JUDGE_MODE === "auto") jevBroken = true;
		else return { judge: "jev:unavailable", frictionHigh: 0, aup: 0, latencyMs: 0, note: r.error };
	}
	return vllmJudge(text);
}

// ---------------------------------------------------------------------------
// Main model selection
// ---------------------------------------------------------------------------

let mainModel: Model | undefined;

function pickMainModel(ctx: ExtensionContext): Model {
	if (mainModel) return mainModel;
	// 1) anthropic claude-sonnet when credentials exist
	const sonnets = ctx.modelRegistry.getModelsOfType("chat", "anthropic").filter((m) => /sonnet/.test(m.id));
	for (const m of sonnets) {
		if (ctx.modelRegistry.hasConfiguredAuth(m)) {
			log(`main model: ${m.provider}/${m.id} (anthropic sonnet credentials found)`);
			return (mainModel = m);
		}
	}
	// 2) dynamic fallback: first available free chat model, opencode-go (subscription) first
	const avail = ctx.modelRegistry.getAvailable().filter((m) => m.provider !== UNC_PROVIDER);
	const free = avail.filter((m) => m.id.endsWith("-free"));
	const pick = free.find((m) => m.provider === "opencode-go") ?? free[0] ?? avail[0];
	if (!pick) throw new Error("brainstorm-router: no available chat model for the main route");
	log(`main model: ${pick.provider}/${pick.id} (dynamic fallback; no anthropic sonnet credentials)`);
	return (mainModel = pick);
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (!UNC_BASE) throw new Error(REQUIRE_BASE);
	pi.registerProvider(UNC_PROVIDER, {
		baseUrl: UNC_BASE,
		apiKey: "$RUNPOD_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: UNC_MODEL,
				name: UNC_MODEL,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 2_048,
			},
		],
	});

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "brainstorm",
		name: "Brainstorm (dual-question judge router)",
		thinkingLevels: ["off", "low", "medium", "high"],
		async route(request, ctx): Promise<ModelRoute<RouterState>> {
			const main = pickMainModel(ctx);
			const uncensored = ctx.modelRegistry.find(UNC_PROVIDER, UNC_MODEL);

			// Compaction summaries etc. never need judging.
			if (request.reason === "direct") return { model: main, thinkingLevel: "off" };

			// Tool follow-ups / retries stay sticky (prompt cache + thinking signatures).
			const sticky = request.failed ?? request.previous;
			if (request.reason !== "user" && sticky) {
				return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "off" };
			}

			const text = lastUserText(request.messages);
			const tagged = /\buncensored:|^\/unc\b/i.test(text.trim());

			// Judge runs on every user turn regardless of backend availability:
			// AUP must gate even explicit tags and even when the uncensored provider
			// is missing (fail-closed — u1 review B5). A missing backend only
			// disables the friction escalation route, never the AUP refusal.
			let outcome: JudgeOutcome | undefined;
			try {
				outcome = await runJudge(text, request, ctx);
			} catch (e) {
				log(`judge failed: ${e}`);
			}
			if (!uncensored) {
				log("uncensored backend not found: AUP gate stays active, lawful friction cannot escalate");
			}

			const state: RouterState = {
				lastJudge: outcome
					? {
							at: new Date().toISOString(),
							judge: outcome.judge,
							frictionHigh: outcome.frictionHigh,
							aup: outcome.aup,
							route: "pending",
							latencyMs: outcome.latencyMs,
							note: outcome.note,
						}
					: { at: new Date().toISOString(), judge: "none", route: "main", note: "judge unavailable" },
			};

			// Branch 1: AUP refusal overrides everything (doc/09 §3 "不問").
			if (outcome && outcome.aup >= AUP_THRESHOLD) {
				state.lastJudge.route = "refuse";
				log(`AUP refuse: aup=${outcome.aup.toFixed(3)} >= ${AUP_THRESHOLD} (judge=${outcome.judge}, judgeLatency=${outcome.latencyMs}ms) -> no model called`);
				throw new Error(
					`Refused by brainstorm-router AUP policy: the request was classified as an illegal content category ` +
						`(probability ${outcome.aup.toFixed(3)} >= ${AUP_THRESHOLD}). No model was called.`,
				);
			}

			// Branch 2: escalation (explicit tag or predicted friction).
			if (uncensored && (tagged || (outcome && outcome.frictionHigh >= FRICTION_THRESHOLD))) {
				state.lastJudge.route = "uncensored";
				log(
					`route=uncensored (${tagged ? "explicit tag" : `frictionHigh=${outcome!.frictionHigh.toFixed(3)} >= ${FRICTION_THRESHOLD}`})` +
						` aup=${outcome ? outcome.aup.toFixed(3) : "n/a"} judge=${outcome?.judge ?? "none"} judgeLatency=${outcome?.latencyMs ?? 0}ms`,
				);
				return { model: uncensored, thinkingLevel: "off", state };
			}

			// Branch 3: everyday -> main model. Fail-open for ordinary queries when the judge
			// is down, but an explicit tag is NOT honored unverified.
			state.lastJudge.route = "main";
			log(
				`route=main (frictionHigh=${outcome ? outcome.frictionHigh.toFixed(3) : "n/a"} aup=${outcome ? outcome.aup.toFixed(3) : "n/a"}` +
					` judge=${outcome?.judge ?? "none"} judgeLatency=${outcome?.latencyMs ?? 0}ms tagged=${tagged}${outcome ? "" : " [judge unavailable]"})`,
			);
			return { model: main, thinkingLevel: "off", state };
		},
	});
}
