/**
 * Jev (jev-1.13) via TypeSafe's System One protocol, called directly over HTTP.
 *
 * Wire format reproduced from @earendil-works/pi-ai (providers/opencode.js +
 * api/typesafe-system-one.js + api/system-one-shared.js):
 *   POST {baseUrl}/systemone        baseUrl = https://opencode.ai/inference/systemone/v1
 *   Authorization: Bearer $OPENCODE_API_KEY
 *   body: { model, state, questions }
 *     - `state` passes through as-is (the router uses { userMessage }).
 *     - public `bool` questions map to the wire-level `noul` type; the answer
 *       comes back as { type: "noul", noul: <probability> }.
 *     - `choice` answers come back as { type: "choice", choice, probabilities, confidence }.
 *   response: { answers: { ... }, usage: { input_tokens, output_tokens } }
 *
 * Retries mirror pi-ai's classifier transport defaults (maxRetries: 2, retried
 * on network errors / timeouts; HTTP failures retry only on 429/5xx).
 */

const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://opencode.ai/inference/systemone/v1";
const JEV_MODEL_ID = process.env.JEV_MODEL ?? "jev-1.13";
const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 60_000);
const JEV_MAX_RETRIES = 2;
/** Catalog price for jev-1.13 input tokens ($0.042/Mtok, output free). */
const JEV_INPUT_USD_PER_MTOK = 0.042;

export interface JevUsage {
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
}

export interface JevDualAnswer {
	frictionHigh: number;
	aup: number;
	usage?: JevUsage | undefined;
}

interface JevQuestion {
	type: "choice" | "noul";
	instructions: string;
	criteria: Record<string, string>;
}

/** Builds the System One wire request. Prompt wording MUST stay identical to the router. */
export function buildJevRequestBody(userMessage: string, questions: Record<string, JevQuestion>): Record<string, unknown> {
	return {
		model: JEV_MODEL_ID,
		state: { userMessage: userMessage.slice(0, 16_000) },
		questions,
	};
}

export function jevModelId(): string {
	return JEV_MODEL_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

function summarize(text: string): string {
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Parses and validates a System One response against the two expected questions. */
export function parseSystemOneResponse(body: unknown): JevDualAnswer {
	if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
	const answers = body.answers;
	if (!isRecord(answers)) throw new Error("System One API did not return answers");

	const friction = answers.friction;
	if (!isRecord(friction) || friction.type !== "choice" || !isRecord(friction.probabilities)) {
		throw new Error("System One API did not return a choice answer for friction");
	}
	const frictionHigh = requiredNumber(
		"System One API",
		friction.probabilities.high,
		"probability for friction.high",
	);

	const aupAnswer = answers.aup;
	if (!isRecord(aupAnswer) || aupAnswer.type !== "noul") {
		throw new Error("System One API did not return a noul answer for aup");
	}
	const aupProbability = requiredNumber("System One API", aupAnswer.noul, "probability for aup.noul");

	let usage: JevUsage | undefined;
	const usageBody = body.usage;
	if (isRecord(usageBody)) {
		const inputTokens =
			typeof usageBody.input_tokens === "number" && Number.isFinite(usageBody.input_tokens)
				? usageBody.input_tokens
				: 0;
		const outputTokens =
			typeof usageBody.output_tokens === "number" && Number.isFinite(usageBody.output_tokens)
				? usageBody.output_tokens
				: 0;
		usage = {
			inputTokens,
			outputTokens,
			estimatedCostUsd: (inputTokens * JEV_INPUT_USD_PER_MTOK) / 1_000_000,
		};
	}
	const result: JevDualAnswer = { frictionHigh, aup: aupProbability };
	if (usage !== undefined) result.usage = usage;
	return result;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one dual-question System One classification.
 * Throws on failure; the caller (judge.ts) falls back to the vLLM logprob judge.
 */
export async function jevClassifyDual(
	userMessage: string,
	questions: Record<string, JevQuestion>,
): Promise<JevDualAnswer> {
	const apiKey = process.env.OPENCODE_API_KEY;
	if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
	const url = `${JEV_BASE_URL.replace(/\/+$/, "")}/systemone`;
	const payload = JSON.stringify(buildJevRequestBody(userMessage, questions));

	let lastError: unknown;
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: payload,
				signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
			});
		} catch (error) {
			// Network error / timeout.
			if (attempt < JEV_MAX_RETRIES) {
				await sleep(1_000 * 2 ** attempt);
				lastError = error;
				continue;
			}
			throw error;
		}
		if (res.ok) {
			return parseSystemOneResponse(await res.json());
		}
		const text = await res.text();
		const error = new Error(`System One HTTP ${res.status}: ${summarize(text)}`);
		if ((res.status === 429 || res.status >= 500) && attempt < JEV_MAX_RETRIES) {
			await sleep(1_000 * 2 ** attempt);
			lastError = error;
			continue;
		}
		throw error;
	}
}
