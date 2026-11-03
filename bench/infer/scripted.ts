/**
 * Offline InferencePort for tests and wiring checks: answers from a function, records every request.
 * Its usage is all null (nothing was measured), never zeros.
 */
import type {
	InferencePort,
	InferenceRequest,
	InferenceResult,
} from "../../src/ports.ts";

export class ScriptedInference implements InferencePort {
	readonly requests: InferenceRequest[] = [];
	constructor(
		private readonly respond: (
			request: InferenceRequest,
		) => string | Promise<string>,
	) {}

	async complete(request: InferenceRequest): Promise<InferenceResult> {
		this.requests.push(request);
		const usage = {
			inputTokens: null,
			cachedTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			calls: 0,
		};
		try {
			const text = await this.respond(request);
			return { ok: true, text, model: "scripted", usage, durationMs: 0 };
		} catch (error) {
			return {
				ok: false,
				error: String(error),
				model: "scripted",
				usage,
				durationMs: 0,
			};
		}
	}
}
