/**
 * Bench driver: runs a checked `ExecutionPlan` step by step against a `PipelineHost`, standing in for
 * the Eumenes pipeline runner (which stays the real executor; plan §5 "実行系を二重に作らない").
 *
 * The rules it enforces are the ones the integration must keep:
 * - steps run in order; a step gets only the request and earlier results its `from` names;
 * - only a `completed` result that satisfies its declared output contract is handed on;
 * - anything else stops the run there (no later step runs, nothing is reported complete);
 * - a result that arrives after cancellation or after the deadline is not adopted.
 */
import type { ExecutionPlan } from "../../src/check.ts";
import { REQUEST_REF } from "../../src/contracts/definition.ts";
import type {
	StepReference,
	StepResult,
	StepState,
} from "../../src/contracts/execution.ts";
import type { PipelineHost } from "../../src/ports.ts";
import type { ValidationResult } from "../catalog/contracts.ts";
import { sha256 } from "../catalog/load.ts";

export type StepOutcome = {
	stepId: string;
	entry: string;
	result: StepResult;
	adopted: boolean;
	/** Why a completed result was still not handed on. */
	rejection?:
		| "result_missing_output"
		| "result_contract_violation"
		| "after_cancel"
		| "after_deadline";
};

export type RunOutcome = {
	runId: string;
	status: "completed" | "stopped" | "cancelled";
	steps: StepOutcome[];
	stoppedAt: { stepId: string; state: StepState; code: string | null } | null;
	/** The references `output.from` hands to the final answer; null unless every step was adopted. */
	delivered: Array<{ from: string; references: StepReference[] }> | null;
};

export type DriverOptions = {
	runId: string;
	/** Checks a completed output against its declared contract. */
	validateOutput: (schemaRef: string, value: unknown) => ValidationResult;
	deadlineMs?: number;
	now?: () => number;
	signal?: AbortSignal;
};

export function requestReference(request: string): StepReference {
	return {
		ref: REQUEST_REF,
		owner: "conversation",
		id: REQUEST_REF,
		revision: "0",
		digest: sha256(request),
		label: "利用者の依頼",
		kind: "message",
		preview: request.slice(0, 2000),
	};
}

export async function runPlan(
	plan: ExecutionPlan,
	host: PipelineHost,
	options: DriverOptions,
): Promise<RunOutcome> {
	const now = options.now ?? Date.now;
	const deadline = now() + (options.deadlineMs ?? 10 * 60_000);
	const source = { request: plan.request, digest: sha256(plan.request) };
	const request = requestReference(plan.request);
	const adopted = new Map<string, StepResult>();
	const steps: StepOutcome[] = [];
	const resolve = (from: string): StepReference[] => {
		if (from === REQUEST_REF) return [request];
		const result = adopted.get(from);
		// A checked plan only names earlier steps, and a run stops at the first unadopted one.
		if (!result) throw new Error(`plan references unadopted step ${from}`);
		return result.references;
	};
	const stop = (
		status: RunOutcome["status"],
		outcome: StepOutcome | null,
	): RunOutcome => ({
		runId: options.runId,
		status,
		steps,
		stoppedAt: outcome
			? {
					stepId: outcome.stepId,
					state: outcome.result.state,
					code: outcome.rejection ?? outcome.result.code ?? null,
				}
			: null,
		delivered: null,
	});

	for (const step of plan.steps) {
		if (options.signal?.aborted) return stop("cancelled", null);
		const result = await host.executeStep(
			{
				runId: options.runId,
				stepId: step.stepId,
				entry: step.entry,
				revisionId: step.revisionId,
				request: step.task,
				...(step.arguments !== undefined ? { arguments: step.arguments } : {}),
				references: step.from.flatMap(resolve),
				source,
				deadline,
			},
			options.signal,
		);
		const outcome: StepOutcome = {
			stepId: step.stepId,
			entry: step.entry,
			result,
			adopted: false,
		};
		steps.push(outcome);
		if (options.signal?.aborted) {
			if (result.state === "completed") outcome.rejection = "after_cancel";
			return stop("cancelled", outcome);
		}
		if (result.state !== "completed") return stop("stopped", outcome);
		if (now() > deadline) {
			outcome.rejection = "after_deadline";
			return stop("stopped", outcome);
		}
		const ref = step.output.schemaRef;
		if (ref) {
			if (result.output === undefined) {
				outcome.rejection = "result_missing_output";
				return stop("stopped", outcome);
			}
			if (!options.validateOutput(ref, result.output).ok) {
				outcome.rejection = "result_contract_violation";
				return stop("stopped", outcome);
			}
		}
		outcome.adopted = true;
		adopted.set(step.stepId, result);
	}
	return {
		runId: options.runId,
		status: "completed",
		steps,
		stoppedAt: null,
		delivered: plan.output.from.map((from) => ({
			from,
			references: resolve(from),
		})),
	};
}
