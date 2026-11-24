/**
 * OpenAI-compatible HTTP core — the standalone product surface.
 *
 * Endpoints:
 *   GET  /health                — status + RunPod balance (checked at startup)
 *   GET  /v1/models             — OpenAI model list (the backend model)
 *   POST /v1/chat/completions   — OpenAI Chat Completions (stream + non-stream)
 *
 * Every chat request passes the centralized dual-question judge (judge.ts,
 * same calibrated prompts/thresholds as pi-extensions/brainstorm-router.ts):
 *   aup >= 0.7                                       -> REFUSE (OpenAI error shape, no model call)
 *   judge unavailable (backend down)                  -> route "default" (an explicit `uncensored:`
 *                                                       tag is unverified and NOT honored)
 *   `uncensored:` tag (judge-verified) or friction>=0.2 -> route "uncensored" -> RunPod 24B
 *   otherwise                                         -> route "default"     -> RunPod 24B
 *
 * Decisions are surfaced in response headers (X-Judge-Friction / X-Judge-Aup /
 * X-Judge-Latency-Ms / X-Judge-Backend / X-Judge-Route) and logged to stderr
 * (never API keys).
 *
 * Budget: the RunPod balance is checked at startup against BALANCE_FLOOR
 * (default $1.00); below the floor the server logs a warning but still starts.
 *
 * Usage: npm run core   (tsx src/core/server.ts)
 *   CORE_PORT (default 8787), CORE_HOST (default 127.0.0.1),
 *   CORE_API_KEY (optional; when set, clients must send `Authorization: Bearer <key>`),
 *   RUNPOD_OPENAI_BASE / RUNPOD_UNCENSORED_MODEL (backend override),
 *   CORE_JUDGE_MODE (jev | vllm | auto, default auto), BALANCE_FLOOR.
 */

import http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { RunPodClient } from "../client.js";
import { callBackend, upstreamBody } from "./backend.js";
import {
	AUP_THRESHOLD,
	BALANCE_FLOOR,
	FRICTION_THRESHOLD,
	HOST,
	MAX_BODY_BYTES,
	PORT,
	UNC_BASE,
	UNC_MODEL,
	log,
} from "./config.js";
import { runJudge, type JudgeOutcome } from "./judge.js";

interface HealthState {
	balanceUsd: number | null;
	billingMode: string | null;
	fetchedAt: string | null;
	belowFloor: boolean | null;
}

const health: HealthState = {
	balanceUsd: null,
	billingMode: null,
	fetchedAt: null,
	belowFloor: null,
};
const startedAt = Date.now();

// ------------------------------------------------------------------ helpers

class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

function openAiError(message: string, type: string, code: string, param: unknown = null): unknown {
	return { error: { message, type, code, param } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw new RequestError(413, "Request body too large", "payload_too_large");
		chunks.push(buf);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.length === 0) throw new RequestError(400, "Request body is empty", "empty_body");
	try {
		return JSON.parse(text);
	} catch {
		throw new RequestError(400, "Request body is not valid JSON", "invalid_json");
	}
}

interface ChatMessageLike {
	role?: unknown;
	content?: unknown;
}

/** Same semantics as the router's lastUserText: last message with role "user". */
function lastUserText(messages: readonly ChatMessageLike[]): string {
	let content: unknown = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "user") {
			content = m.content ?? "";
			break;
		}
	}
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((block) => {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					return [(block as { text: string }).text];
				}
				return [];
			})
			.join("\n");
	}
	return "";
}

/** The router's explicit-escalation tag (verbatim). */
function hasUncensoredTag(text: string): boolean {
	return /\buncensored:|^\/unc\b/i.test(text.trim());
}

function judgeHeaders(outcome: JudgeOutcome | null, route: string): Record<string, string> {
	return {
		"X-Judge-Backend": outcome?.backend ?? "none",
		"X-Judge-Friction": (outcome?.frictionHigh ?? 0).toFixed(3),
		"X-Judge-Aup": (outcome?.aup ?? 0).toFixed(3),
		"X-Judge-Latency-Ms": String(outcome?.latencyMs ?? 0),
		"X-Judge-Route": route,
	};
}

function requireAuth(req: http.IncomingMessage): void {
	const expected = process.env.CORE_API_KEY;
	if (!expected) return;
	const auth = req.headers.authorization;
	if (auth !== `Bearer ${expected}`) {
		throw new RequestError(401, "Invalid or missing API key", "invalid_api_key");
	}
}

// ------------------------------------------------------------------ handlers

function handleHealth(res: http.ServerResponse): void {
	sendJson(res, 200, {
		status: "ok",
		uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
		balance: {
			usd: health.balanceUsd,
			billingMode: health.billingMode,
			fetchedAt: health.fetchedAt,
			belowFloor: health.belowFloor,
			floorUsd: BALANCE_FLOOR,
		},
		backend: { base: UNC_BASE, model: UNC_MODEL },
		thresholds: { aup: AUP_THRESHOLD, friction: FRICTION_THRESHOLD },
	});
}

function handleModels(res: http.ServerResponse): void {
	sendJson(res, 200, {
		object: "list",
		data: [
			{
				id: UNC_MODEL,
				object: "model",
				created: Math.floor(startedAt / 1000),
				owned_by: "runpod",
			},
		],
	});
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	requireAuth(req);
	const parsed = await readJsonBody(req);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new RequestError(400, "Request body must be a JSON object", "invalid_request");
	}
	const body = parsed as Record<string, unknown>;
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw new RequestError(400, "messages: at least one message is required", "invalid_request");
	}
	const stream = body.stream === true;

	const text = lastUserText(body.messages as readonly ChatMessageLike[]);
	const tagged = hasUncensoredTag(text);

	// Judge runs on every user turn: AUP must gate even explicit tags.
	let outcome: JudgeOutcome | null = null;
	if (text.trim().length > 0) {
		try {
			outcome = await runJudge(text);
		} catch (error) {
			// Judge entirely down (Jev failed AND vllm fallback failed).
			// Fail open for ordinary requests (they route to "default"), but do
			// NOT honor an explicit uncensored tag unverified: an unverified tag
			// also falls back to "default" (see the route decision below).
			const msg = error instanceof Error ? error.message : String(error);
			log(`judge failed: ${msg} (fail-open, tagged=${tagged} unverified)`);
		}
	}

	// Branch 1: AUP refusal overrides everything, explicit tags included. No model call.
	if (outcome && outcome.aup >= AUP_THRESHOLD) {
		const headers = judgeHeaders(outcome, "refuse");
		log(
			`AUP refuse: aup=${outcome.aup.toFixed(3)} >= ${AUP_THRESHOLD} (judge=${outcome.backend}, ` +
				`judgeLatency=${outcome.latencyMs}ms) -> no model called`,
		);
		sendJson(
			res,
			400,
			openAiError(
				`Refused by AUP policy: the request was classified as an illegal content category ` +
					`(probability ${outcome.aup.toFixed(3)} >= ${AUP_THRESHOLD}). No model was called.`,
				"invalid_request_error",
				"content_policy_violation",
			),
			headers,
		);
		return;
	}

	// Branch 2/3: both routes are served by the RunPod 24B backend. The only
	// aligned "main model" in this standalone core is the same endpoint; the
	// distinction is recorded in headers/logs for observability.
	// Fail-closed for tags: when the judge is entirely down (outcome === null)
	// an explicit uncensored tag is unverified and MUST NOT reach the
	// uncensored route — it falls back to "default" like any other request.
	if (tagged && outcome === null) {
		log("tag unverified (judge down) -> default");
	}
	const route =
		outcome !== null && (tagged || outcome.frictionHigh >= FRICTION_THRESHOLD)
			? "uncensored"
			: "default";
	const headers = judgeHeaders(outcome, route);
	log(
		`route=${route} (${tagged && outcome !== null ? "explicit tag" : outcome ? "judge" : "judge unavailable"}) ` +
			`frictionHigh=${outcome ? outcome.frictionHigh.toFixed(3) : "n/a"} ` +
			`aup=${outcome ? outcome.aup.toFixed(3) : "n/a"} judge=${outcome?.backend ?? "none"} ` +
			`judgeLatency=${outcome?.latencyMs ?? 0}ms` +
			(outcome?.usage
				? ` judgeTokens=${outcome.usage.inputTokens}+${outcome.usage.outputTokens} (~$${outcome.usage.estimatedCostUsd.toFixed(6)})`
				: ""),
	);

	const upstream = await callBackend(upstreamBody({ ...body, ...(stream ? { stream: true } : { stream: false }) }));

	const contentType = stream ? "text/event-stream" : "application/json";
	res.writeHead(upstream.response.status, {
		"Content-Type": contentType,
		"Cache-Control": "no-cache",
		...headers,
	});

	if (stream && upstream.response.ok && upstream.response.body) {
		// Relay SSE chunks as they arrive (no buffering of the whole stream).
		const nodeStream = Readable.fromWeb(upstream.response.body as unknown as NodeWebReadableStream<Uint8Array>);
		nodeStream.pipe(res);
		return;
	}
	const textBody = await upstream.response.text();
	res.end(textBody);
}

// ------------------------------------------------------------------ startup

async function checkBalance(): Promise<void> {
	try {
		const client = new RunPodClient();
		const { data } = await client.getBalance();
		const usd = data.balanceAmount;
		health.balanceUsd = usd;
		health.billingMode = String(data.billingMode);
		health.fetchedAt = new Date().toISOString();
		health.belowFloor = usd < BALANCE_FLOOR;
		if (usd < BALANCE_FLOOR) {
			log(`WARNING: RunPod balance $${usd.toFixed(2)} is below the BALANCE_FLOOR $${BALANCE_FLOOR.toFixed(2)} (warning only; the server still starts)`);
		} else {
			log(`RunPod balance: $${usd.toFixed(2)} (floor $${BALANCE_FLOOR.toFixed(2)} OK)`);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log(`balance check failed (continuing): ${msg}`);
	}
}

async function main(): Promise<void> {
	log(`backend: ${UNC_MODEL} @ ${UNC_BASE}`);
	log(`thresholds: aup>=${AUP_THRESHOLD} refuse; friction>=${FRICTION_THRESHOLD} -> uncensored route`);
	await checkBalance();

	if (!UNC_BASE) {
		console.error(
			"[core] RUNPOD_OPENAI_BASE is required (https://api.runpod.ai/v2/<your-endpoint-id>/openai/v1). " +
				"No endpoint is bundled in this repo. Exiting.",
		);
		process.exit(1);
	}

	const server = http.createServer((req, res) => {
		void (async () => {
			try {
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
				if (req.method === "GET" && url.pathname === "/health") return handleHealth(res);
				if (req.method === "GET" && url.pathname === "/v1/models") return handleModels(res);
				if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
					return await handleChatCompletions(req, res);
				}
				sendJson(res, 404, openAiError(`Not found: ${req.method} ${url.pathname}`, "invalid_request_error", "not_found"));
			} catch (error) {
				if (res.headersSent) {
					log(`request failed mid-response: ${error instanceof Error ? error.message : String(error)}`);
					res.destroy();
					return;
				}
				if (error instanceof RequestError) {
					sendJson(res, error.status, openAiError(error.message, "invalid_request_error", error.code));
				} else {
					const msg = error instanceof Error ? error.message : String(error);
					log(`request failed: ${msg}`);
					sendJson(res, 502, openAiError(msg, "api_error", "upstream_error"));
				}
			}
		})();
	});

	server.listen(PORT, HOST, () => {
		log(`listening on http://${HOST}:${PORT} (auth: ${process.env.CORE_API_KEY ? "CORE_API_KEY required" : "open"})`);
	});
}

void main();
