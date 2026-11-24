/**
 * RunPod OpenAI-compatible backend (uncensored main axis).
 *
 * The core forwards accepted requests here after the judge decision. Any model
 * id the client sends is overridden with the configured backend model.
 */

import { UNC_BASE, UNC_MODEL } from "./config.js";

/** Upstream chat completions URL (OpenAI-compatible vLLM serverless endpoint). */
export function chatCompletionsUrl(): string {
	return `${UNC_BASE.replace(/\/+$/, "")}/chat/completions`;
}

export interface BackendCall {
	/** Upstream Response; the caller relays status/body/stream to the client. */
	response: Response;
	latencyMs: number;
}

/**
 * Calls the RunPod backend. `body` must already carry the resolved model id.
 * No timeout: a cold vLLM worker can take minutes to boot (see docs/DEPLOYMENT.md);
 * FlashBoot warm starts answer in seconds.
 */
export async function callBackend(body: Record<string, unknown>): Promise<BackendCall> {
	const apiKey = process.env.RUNPOD_API_KEY;
	if (!apiKey) throw new Error("RUNPOD_API_KEY is not set");
	const t0 = Date.now();
	const response = await fetch(chatCompletionsUrl(), {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { response, latencyMs: Date.now() - t0 };
}

/** Rewrites a client request for the backend: forces the configured model. */
export function upstreamBody(body: Record<string, unknown>): Record<string, unknown> {
	return { ...body, model: UNC_MODEL };
}
