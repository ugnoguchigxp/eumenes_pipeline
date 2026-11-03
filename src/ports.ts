/**
 * Typed ports the host hands to this package (plan §5, §6). The package never opens connections,
 * reads credentials or names models itself: Eumenes implements these with its agent/tool runtime and
 * its LARM connection; the bench implements them with the mock host and the Muse inference adapter.
 */
import type { StepExecution, StepResult } from "./contracts/execution.ts";

/**
 * The part of `AbortSignal` this package relies on. A real `AbortSignal` satisfies it; the type is
 * structural so the package needs neither DOM nor Bun/Node type libraries.
 */
export type CancelSignal = { readonly aborted: boolean };

/** Runs one step as a child execution of a registered entry; the host owns queues, waits and cancels. */
export interface PipelineHost {
	executeStep(step: StepExecution, signal?: CancelSignal): Promise<StepResult>;
}

export type InferenceRequest = {
	/** What the call is for (`compose`, `revise`, `judge`, ...); recorded with its usage. */
	purpose: string;
	system?: string;
	prompt: string;
	/** JSON Schema the final answer must follow, when the provider supports constrained output. */
	outputSchema?: Record<string, unknown>;
};

/** Token counts as reported by the provider; null when it reports none (never 0 in its place). */
export type InferenceUsage = {
	inputTokens: number | null;
	cachedTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	/** Provider model calls this request caused, including retries and helpers; null when unreported. */
	calls: number | null;
};

export type InferenceResult =
	| {
			ok: true;
			text: string;
			model: string | null;
			usage: InferenceUsage;
			durationMs: number;
	  }
	| {
			ok: false;
			error: string;
			model: string | null;
			usage: InferenceUsage;
			durationMs: number;
	  };

export interface InferencePort {
	complete(
		request: InferenceRequest,
		signal?: CancelSignal,
	): Promise<InferenceResult>;
}
