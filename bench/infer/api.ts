/** Provider wire contracts only; generation and judgement keep the shared InferencePort. */
import { z } from "zod";
import type {
	CancelSignal,
	InferencePort,
	InferenceRequest,
	InferenceResult,
	InferenceUsage,
} from "../../src/ports.ts";
import type { ApiBudget } from "../store/api-budget.ts";
import { inferenceDigest } from "./recorded.ts";
import {
	API_ENDPOINTS,
	apiCredential,
	type ApiProvider,
} from "./api-config.ts";

export const apiProfile = z.strictObject({
	provider: z.enum(["anthropic", "openai"]),
	model: z.string().min(1),
	apiVersion: z.string().optional(),
	contextTokensCeiling: z.number().int().positive().max(1_100_000),
	inputUsdPerMillionCeiling: z.number().positive(),
	outputUsdPerMillionCeiling: z.number().positive(),
	pricingSource: z.string().url(),
	pricingCheckedAt: z.string(),
	settings: z.record(z.string(), z.unknown()),
});
export type ApiProfile = z.infer<typeof apiProfile>;

export type ApiEvidence = {
	requestId: string;
	providerRequestId: string | null;
	responseId: string | null;
	requestedModel: string;
	returnedModel: string | null;
	provider: ApiProvider;
	promptDigest: string;
	status: number | null;
	requestBody: Record<string, unknown>;
	response: unknown;
	durationMs: number;
	usage: InferenceUsage;
	actualBilledUsd: null;
};

type FetchPort = (url: string, init: RequestInit) => Promise<Response>;
const object = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const integer = (v: unknown): number | null =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const noUsage = (): InferenceUsage => ({
	inputTokens: null,
	outputTokens: null,
	cachedTokens: null,
	reasoningTokens: null,
	calls: null,
});

/** Bound bytes while reading, including responses without a Content-Length header. */
async function readResponse(
	http: Response,
	signal: AbortSignal,
): Promise<string> {
	const limit = 2_000_000;
	const reader = http.body?.getReader();
	if (!reader) return "";
	let ended = false;
	try {
		if (Number(http.headers.get("content-length")) > limit)
			throw new Error("API response exceeds limit");
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			if (signal.aborted) throw new Error("cancelled or deadline exceeded");
			let abort: (() => void) | undefined;
			const cancelled = new Promise<never>((_resolve, reject) => {
				abort = () => reject(new Error("cancelled or deadline exceeded"));
				signal.addEventListener("abort", abort, { once: true });
			});
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await Promise.race([reader.read(), cancelled]);
			} finally {
				if (abort) signal.removeEventListener("abort", abort);
			}
			if (chunk.done) {
				ended = true;
				break;
			}
			size += chunk.value.byteLength;
			if (size > limit) throw new Error("API response exceeds limit");
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} finally {
		if (!ended) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export class ApiInference implements InferencePort {
	readonly #profile: ApiProfile;
	readonly #options: {
		budget: ApiBudget;
		maxOutputTokens: number;
		timeoutMs: number;
		env?: Record<string, string | undefined>;
		fetcher?: FetchPort;
		onEvidence?: (evidence: ApiEvidence) => void;
	};
	constructor(
		profile: ApiProfile,
		options: {
			budget: ApiBudget;
			maxOutputTokens: number;
			timeoutMs: number;
			env?: Record<string, string | undefined>;
			fetcher?: FetchPort;
			onEvidence?: (evidence: ApiEvidence) => void;
		},
	) {
		this.#profile = apiProfile.parse(profile);
		if (
			!Number.isSafeInteger(options.maxOutputTokens) ||
			options.maxOutputTokens < 1 ||
			options.maxOutputTokens > 8192 ||
			!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs < 1 ||
			options.timeoutMs > 300_000
		)
			throw new Error("invalid API output or deadline limit");
		const allowed =
			profile.provider === "openai" ? ["reasoning"] : ["thinking"];
		if (Object.keys(profile.settings).some((k) => !allowed.includes(k)))
			throw new Error(
				"unsupported request setting; tools and request overrides are forbidden",
			);
		if (profile.provider === "anthropic" && !profile.apiVersion)
			throw new Error("Anthropic API version must be frozen");
		this.#options = options;
	}

	async complete(
		request: InferenceRequest,
		signal?: CancelSignal,
	): Promise<InferenceResult> {
		const p = this.#profile;
		const o = this.#options;
		const started = performance.now();
		const failure = (error: string): InferenceResult => ({
			ok: false,
			error,
			model: p.model,
			usage: noUsage(),
			durationMs: performance.now() - started,
		});
		if (signal?.aborted) return failure("cancelled before request");
		const credential = apiCredential(p.provider, o.env);
		const redact = (value: string) =>
			value.replaceAll(credential.key, "[REDACTED]");
		// Normalize JSON escapes before redacting reflected response values or identifiers.
		const redactJson = <T>(value: T): T =>
			JSON.parse(
				JSON.stringify(value).replaceAll(
					JSON.stringify(credential.key).slice(1, -1),
					"[REDACTED]",
				),
			) as T;
		if ((request.system?.length ?? 0) + request.prompt.length > 100_000)
			return failure("input exceeds bench character limit");
		const body: Record<string, unknown> =
			p.provider === "openai"
				? {
						model: p.model,
						instructions: request.system ?? "",
						input: request.prompt,
						max_output_tokens: o.maxOutputTokens,
						store: false,
						service_tier: "default",
						...p.settings,
						...(request.outputSchema
							? {
									text: {
										format: {
											type: "json_schema",
											name: "pipeline_output",
											strict: true,
											schema: request.outputSchema,
										},
									},
								}
							: {}),
					}
				: {
						model: p.model,
						system: request.system ?? "",
						messages: [{ role: "user", content: request.prompt }],
						max_tokens: o.maxOutputTokens,
						...p.settings,
						...(request.outputSchema
							? {
									output_config: {
										format: {
											type: "json_schema",
											schema: request.outputSchema,
										},
									},
								}
							: {}),
					};
		const wireBody = JSON.stringify(body);
		if (new TextEncoder().encode(wireBody).byteLength > 200_000)
			return failure("wire request exceeds limit");
		// Reserve the full model context, not an estimated tokenizer count. Use conservative,
		// versioned rates that cover long-context/cache variants; actual billing remains unknown.
		const reserved =
			(p.contextTokensCeiling * p.inputUsdPerMillionCeiling +
				o.maxOutputTokens * p.outputUsdPerMillionCeiling) /
			1_000_000;
		const requestId = o.budget.reserve(reserved, {
			provider: p.provider,
			model: p.model,
			purpose: request.purpose,
			promptDigest: inferenceDigest(request),
			pricing: p,
		});
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), o.timeoutMs);
		const cancellation = signal
			? setInterval(() => {
					if (signal.aborted) controller.abort();
				}, 20)
			: undefined;
		let status: number | null = null;
		let response: unknown = null;
		let providerRequestId: string | null = null;
		let usage = noUsage();
		let returnedModel: string | null = null;
		try {
			const http = await (o.fetcher ?? fetch)(API_ENDPOINTS[p.provider], {
				method: "POST",
				redirect: "error",
				signal: controller.signal,
				headers:
					p.provider === "openai"
						? {
								"content-type": "application/json",
								authorization: `Bearer ${credential.key}`,
							}
						: {
								"content-type": "application/json",
								"x-api-key": credential.key,
								"anthropic-version": p.apiVersion!,
							},
				body: wireBody,
			});
			status = http.status;
			providerRequestId =
				http.headers.get("request-id") ?? http.headers.get("x-request-id");
			const text = redact(await readResponse(http, controller.signal));
			response = redactJson(JSON.parse(text) as unknown);
			const r = object(response);
			returnedModel = typeof r.model === "string" ? r.model : null;
			const u = object(r.usage);
			usage = {
				inputTokens: integer(u.input_tokens),
				outputTokens: integer(u.output_tokens),
				cachedTokens: integer(
					p.provider === "openai"
						? object(u.input_tokens_details).cached_tokens
						: u.cache_read_input_tokens,
				),
				reasoningTokens: integer(
					object(u.output_tokens_details).reasoning_tokens,
				),
				calls: null,
			};
			const cacheCreated =
				p.provider === "anthropic"
					? (integer(u.cache_creation_input_tokens) ?? 0)
					: 0;
			const cacheRead =
				p.provider === "anthropic" ? (usage.cachedTokens ?? 0) : 0;
			const cacheUsageKnown =
				p.provider !== "anthropic" ||
				(integer(u.cache_creation_input_tokens) !== null &&
					integer(u.cache_read_input_tokens) !== null);
			if (
				usage.inputTokens !== null &&
				usage.outputTokens !== null &&
				cacheUsageKnown
			) {
				const input = usage.inputTokens + cacheCreated + cacheRead;
				if (
					input > p.contextTokensCeiling ||
					usage.outputTokens > o.maxOutputTokens
				)
					throw new Error("provider usage exceeds reserved limits");
				o.budget.settle(
					requestId,
					(input * p.inputUsdPerMillionCeiling +
						usage.outputTokens * p.outputUsdPerMillionCeiling) /
						1_000_000,
					{ usage: u, actualBilledUsd: null },
				);
			}
			if (!http.ok) throw new Error(`API HTTP ${http.status}`);
			if (returnedModel !== p.model)
				throw new Error("returned model differs from frozen model");
			if (controller.signal.aborted || signal?.aborted)
				throw new Error("cancelled or deadline exceeded");
			const blocks = p.provider === "anthropic" ? r.content : r.output;
			if (!Array.isArray(blocks)) throw new Error("missing API content blocks");
			const texts: string[] = [];
			if (p.provider === "anthropic") {
				if (r.stop_reason !== "end_turn")
					throw new Error(`API stop reason: ${String(r.stop_reason)}`);
				for (const value of blocks) {
					const b = object(value);
					if (b.type === "text" && typeof b.text === "string")
						texts.push(b.text);
					else if (b.type !== "thinking" && b.type !== "redacted_thinking")
						throw new Error("unexpected API content block");
				}
			} else {
				if (r.status !== "completed")
					throw new Error(`API response status: ${String(r.status)}`);
				for (const value of blocks) {
					const b = object(value);
					if (b.type === "reasoning") continue;
					if (b.type !== "message" || !Array.isArray(b.content))
						throw new Error("unexpected API output block");
					for (const value of b.content) {
						const part = object(value);
						if (part.type !== "output_text" || typeof part.text !== "string")
							throw new Error("API refusal or non-text output");
						texts.push(part.text);
					}
				}
			}
			if (!texts.join("").trim()) throw new Error("empty API output");
			return {
				ok: true,
				text: texts.join("\n"),
				model: returnedModel,
				usage,
				durationMs: performance.now() - started,
			};
		} catch (error) {
			const message = controller.signal.aborted
				? "cancelled or deadline exceeded"
				: error instanceof Error
					? redact(error.message)
					: "API request failed";
			return {
				ok: false,
				error: message,
				model: returnedModel ?? p.model,
				usage,
				durationMs: performance.now() - started,
			};
		} finally {
			clearTimeout(timeout);
			clearInterval(cancellation);
			o.onEvidence?.(
				redactJson({
					requestId,
					providerRequestId,
					responseId:
						typeof object(response).id === "string"
							? (object(response).id as string)
							: null,
					requestedModel: p.model,
					returnedModel,
					provider: p.provider,
					promptDigest: inferenceDigest(request),
					status,
					requestBody: body,
					response,
					durationMs: performance.now() - started,
					usage,
					actualBilledUsd: null,
				}),
			);
		}
	}
}
