/**
 * Mock host: executes steps against the entry's public contract without reaching any real tool
 * (plan §10 "実カタログ・モックによる部品選択評価").
 *
 * Rules it keeps:
 * - It answers with the CHOSEN entry's own contract. It never sees cases, gold labels or the
 *   expected entry, so a wrong choice gets that wrong entry's result, never the right one.
 * - Its values are synthetic and deterministic (seed + entry + step + request digest).
 * - It reproduces the host states a pipeline must handle (failure, cancel, expiry, a question,
 *   indeterminate) and two host defects (missing output, wrong type) the pipeline must catch.
 * - A value it synthesizes that breaks the entry's own contract is a bench defect: it throws
 *   `MockDefect` instead of returning something a step could adopt.
 */
import type { CatalogView } from "../../src/catalog.ts";
import type { ComponentRecord } from "../../src/contracts/component.ts";
import type {
	StepExecution,
	StepReference,
	StepResult,
	StepState,
} from "../../src/contracts/execution.ts";
import type { PipelineHost } from "../../src/ports.ts";
import {
	validateAgainst,
	type ContractSet,
	type ValidationResult,
} from "../catalog/contracts.ts";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import { SynthesisError, synthesize } from "./synth.ts";

export type MockScenario =
	| { kind: "complete" }
	| { kind: "fail"; code?: string }
	| { kind: "cancel" }
	| { kind: "expire" }
	| { kind: "ask"; question: string }
	| { kind: "indeterminate" }
	/** Host defect: completed without the output its contract declares. */
	| { kind: "drop-output" }
	/** Host defect: completed with an output that breaks its contract. */
	| { kind: "wrong-type" };

/**
 * Typed arguments of instant entries (plan §5: open until P0b):
 * - `entry-structures`: the entry's own model structures them from the request (mock: synthesized
 *   from the entry's input schema, recorded as such);
 * - `required`: the step must supply them; a step without them fails `missing_arguments`.
 */
export type ArgumentsPolicy = "entry-structures" | "required";

export type MockCall = {
	seq: number;
	runId: string;
	stepId: string;
	entry: string;
	revisionId: string;
	requestDigest: string;
	referenceDigests: string[];
	arguments: unknown;
	argumentsSource: "step" | "synthesized" | "none";
	scenario: MockScenario["kind"];
	state: StepState;
	code: string | null;
	outputDigest: string | null;
	at: number;
};

export class MockDefect extends Error {}

export type MockHostOptions = {
	catalog: Pick<CatalogView, "all">;
	contracts: ContractSet;
	seed: string;
	scenario?: (step: StepExecution) => MockScenario;
	argumentsPolicy?: ArgumentsPolicy;
	now?: () => number;
	onCall?: (call: MockCall) => void;
};

const WRONG_TYPE_VALUE = 42;

export class MockHost implements PipelineHost {
	readonly calls: MockCall[] = [];
	readonly #options: Required<Omit<MockHostOptions, "onCall" | "scenario">> &
		Pick<MockHostOptions, "onCall" | "scenario">;

	constructor(options: MockHostOptions) {
		this.#options = {
			argumentsPolicy: "entry-structures",
			now: Date.now,
			...options,
		};
	}

	async executeStep(
		step: StepExecution,
		signal?: AbortSignal,
	): Promise<StepResult> {
		const { catalog, contracts, now } = this.#options;
		const requestDigest = sha256(step.request);
		const seed = `${this.#options.seed}|${step.entry}|${step.stepId}|${requestDigest}`;
		const scenario = this.#options.scenario?.(step) ?? { kind: "complete" };
		const record = catalog.all.get(step.entry);
		let args: unknown = step.arguments;
		let argumentsSource: MockCall["argumentsSource"] =
			step.arguments === undefined ? "none" : "step";

		const finish = (
			result: StepResult,
			output: unknown = undefined,
		): StepResult => {
			const call: MockCall = {
				seq: this.calls.length + 1,
				runId: step.runId,
				stepId: step.stepId,
				entry: step.entry,
				revisionId: step.revisionId,
				requestDigest,
				referenceDigests: step.references.map((r) => r.digest),
				arguments: args ?? null,
				argumentsSource,
				scenario: scenario.kind,
				state: result.state,
				code: result.code ?? null,
				outputDigest:
					output === undefined ? null : sha256(canonicalJson(output)),
				at: now(),
			};
			this.calls.push(call);
			this.#options.onCall?.(call);
			return result;
		};
		const stopped = (state: StepState, code: string, summary: string) =>
			finish({ state, code, summary, references: [], modelCalls: 0 });

		if (signal?.aborted)
			return stopped("cancelled", "aborted", "[mock] cancelled before start");
		if (now() > step.deadline)
			return stopped(
				"expired",
				"deadline",
				"[mock] deadline passed before start",
			);
		if (!record)
			return stopped(
				"failed",
				"unknown_entry",
				`[mock] no entry ${step.entry}`,
			);
		if (record.support === "excluded")
			return stopped(
				"failed",
				"entry_not_executable",
				`[mock] ${step.entry} is not executable as a step`,
			);
		if (record.evidence.toolchainRevisionId !== step.revisionId)
			return stopped(
				"failed",
				"revision_mismatch",
				`[mock] ${step.entry} is at ${record.evidence.toolchainRevisionId}, not ${step.revisionId}`,
			);

		const argsSchema = record.card.arguments;
		if (!argsSchema && step.arguments !== undefined)
			return stopped(
				"failed",
				"unexpected_arguments",
				`[mock] ${step.entry} takes no arguments`,
			);
		if (argsSchema) {
			const inputRef = record.evidence.inputSchemaRefs[0];
			// The extracted contract when the entry names one, else the card's own schema: never unchecked.
			const checkArgs = (value: unknown) =>
				inputRef
					? contracts.validate(inputRef, value)
					: validateAgainst(argsSchema, value);
			if (step.arguments === undefined) {
				if (this.#options.argumentsPolicy === "required")
					return stopped(
						"failed",
						"missing_arguments",
						`[mock] ${step.entry} needs arguments`,
					);
				args = this.#synthesize(
					argsSchema,
					`${seed}|arguments`,
					inputRef ?? `${step.entry} arguments`,
					checkArgs,
				);
				argumentsSource = "synthesized";
			} else {
				const checked = checkArgs(step.arguments);
				if (!checked.ok)
					return stopped(
						"failed",
						"invalid_arguments",
						`[mock] arguments rejected: ${checked.issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`,
					);
			}
		}

		switch (scenario.kind) {
			case "fail":
				return stopped(
					"failed",
					scenario.code ?? "mock_failure",
					"[mock] failed",
				);
			case "cancel":
				return stopped("cancelled", "cancelled", "[mock] cancelled");
			case "expire":
				return stopped("expired", "deadline", "[mock] expired");
			case "indeterminate":
				return stopped(
					"indeterminate",
					"indeterminate",
					"[mock] outcome unknown",
				);
			case "ask":
				return finish({
					state: "waiting_input",
					code: "question",
					summary: "[mock] waiting for the user",
					question: scenario.question,
					references: [],
					modelCalls: 0,
				});
			default:
				break;
		}

		const ref = record.card.output.schemaRef;
		let output: unknown;
		if (scenario.kind === "wrong-type") output = WRONG_TYPE_VALUE;
		else if (ref && scenario.kind !== "drop-output") {
			const schema = contracts.schema(ref);
			if (!schema) throw new MockDefect(`no schema for ${ref}`);
			output = this.#synthesize(schema, `${seed}|output`, ref, (value) =>
				contracts.validate(ref, value),
			);
		}
		const summary = `[mock] ${record.card.title}: completed`;
		return finish(
			{
				state: "completed",
				summary,
				...(output === undefined ? {} : { output }),
				references: this.#references(step, record, summary, output),
				modelCalls: 0,
			},
			output,
		);
	}

	/** Synthesize and check against the same contract; a mismatch is a bench defect, never a result. */
	#synthesize(
		schema: Record<string, unknown>,
		seed: string,
		label: string,
		check: (value: unknown) => ValidationResult,
	): unknown {
		let value: unknown;
		try {
			value = synthesize(schema, seed);
		} catch (error) {
			if (error instanceof SynthesisError)
				throw new MockDefect(`${label}: ${error.message}`);
			throw error;
		}
		const checked = check(value);
		if (!checked.ok)
			throw new MockDefect(
				`synthesized value breaks ${label}: ${checked.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
			);
		return value;
	}

	#references(
		step: StepExecution,
		record: ComponentRecord,
		summary: string,
		output: unknown,
	): StepReference[] {
		const body = canonicalJson({ summary, output: output ?? null });
		const refs: StepReference[] = [
			{
				ref: `result:${step.runId}:${step.stepId}`,
				owner: record.card.bundle ?? record.card.entry,
				id: `${step.runId}/${step.stepId}`,
				revision: record.evidence.toolchainRevisionId,
				digest: sha256(body),
				label: record.card.title,
				kind: "result",
				preview: body.slice(0, 2000),
			},
		];
		// A fixture artifact (image/music) is also handed on as an artifact reference, like Eumenes materials.
		if (
			output &&
			typeof output === "object" &&
			"kind" in output &&
			"id" in output &&
			typeof output.id === "string"
		)
			refs.push({
				ref: `artifact:${String(output.kind)}:${output.id}`,
				owner: record.card.bundle ?? record.card.entry,
				id: output.id,
				revision: "1",
				digest: sha256(canonicalJson(output)),
				label: "title" in output ? String(output.title) : output.id,
				kind: "artifact",
				preview: canonicalJson(output).slice(0, 2000),
			});
		return refs;
	}
}
