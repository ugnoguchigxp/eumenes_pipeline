/**
 * Structural check of a parsed definition against the offered catalog, producing the execution
 * plan the host runs (plan §3, §5). Code checks schema, references, order and contracts only; it
 * never judges whether a step fits the request (that is the LLM's and the evaluator's job).
 */
import type { CatalogView } from "./catalog.ts";
import type { ContractOrigin, ExecutionKind } from "./contracts/component.ts";
import {
	pipelineDefinition,
	REQUEST_REF,
	type PipelineDefinition,
} from "./contracts/definition.ts";

export type IssueCode =
	| "schema"
	| "duplicate_id"
	| "reserved_id"
	| "unknown_reference"
	| "forward_reference"
	| "self_reference"
	| "duplicate_reference"
	| "unknown_component"
	| "ambiguous_entry"
	| "entry_not_in_bundle"
	| "component_not_offered"
	| "unused_result";

export type Issue = {
	code: IssueCode;
	/** JSON path into the definition, e.g. `steps.1.from.0`. */
	path: string;
	message: string;
	/** `warning` never blocks a plan; unused steps are measured by the evaluator, not rejected. */
	severity: "error" | "warning";
	candidates?: string[];
};

export type PlannedStep = {
	stepId: string;
	entry: string;
	bundle: string | null;
	revisionId: string;
	execution: ExecutionKind;
	task: string;
	from: string[];
	expectedResult: string;
	/** The result contract a completed step must satisfy; the host checks it before handing it on. */
	output: { schemaRef: string | null; origin: ContractOrigin };
};

/** What the host executes: steps in order, each with resolved entry and revision. */
export type ExecutionPlan = {
	request: string;
	steps: PlannedStep[];
	output: { from: string[]; deliver: string };
	catalogVersion: string;
};

export type CheckResult =
	| {
			ok: true;
			definition: PipelineDefinition;
			plan: ExecutionPlan;
			issues: Issue[];
	  }
	| { ok: false; issues: Issue[] };

export function checkDefinition(
	input: unknown,
	catalog: CatalogView,
): CheckResult {
	const parsed = pipelineDefinition.safeParse(input);
	if (!parsed.success)
		return {
			ok: false,
			issues: parsed.error.issues.map((issue) => ({
				code: "schema",
				path: issue.path.join("."),
				message: issue.message,
				severity: "error",
			})),
		};
	const definition = parsed.data;
	const issues: Issue[] = [];
	const error = (
		code: IssueCode,
		path: string,
		message: string,
		candidates?: string[],
	) =>
		issues.push({
			code,
			path,
			message,
			severity: "error",
			...(candidates?.length ? { candidates } : {}),
		});

	const position = new Map<string, number>();
	definition.steps.forEach((step, index) => {
		if (step.id === REQUEST_REF)
			error("reserved_id", `steps.${index}.id`, `"${REQUEST_REF}" is reserved`);
		else if (position.has(step.id))
			error(
				"duplicate_id",
				`steps.${index}.id`,
				`duplicate step id "${step.id}"`,
			);
		else position.set(step.id, index);
	});

	const used = new Set<string>();
	const checkRefs = (refs: string[], path: string, at: number) => {
		const seen = new Set<string>();
		refs.forEach((ref, i) => {
			const where = `${path}.${i}`;
			if (seen.has(ref))
				return error("duplicate_reference", where, `"${ref}" listed twice`);
			seen.add(ref);
			if (ref === REQUEST_REF) return;
			const target = position.get(ref);
			if (target === undefined)
				return error("unknown_reference", where, `no step "${ref}"`);
			if (target === at)
				return error("self_reference", where, `a step cannot use itself`);
			if (target > at)
				return error(
					"forward_reference",
					where,
					`"${ref}" runs after this step`,
				);
			used.add(ref);
		});
	};

	const steps: PlannedStep[] = [];
	definition.steps.forEach((step, index) => {
		checkRefs(step.from, `steps.${index}.from`, index);
		const resolved = catalog.resolve(step.bundle, step.entry);
		if (!resolved.ok) {
			error(
				resolved.code,
				`steps.${index}.${step.entry === undefined ? "bundle" : "entry"}`,
				`cannot use ${step.entry ?? step.bundle}: ${resolved.code}`,
				resolved.candidates,
			);
			return;
		}
		const { record } = resolved;
		steps.push({
			stepId: step.id,
			entry: record.card.entry,
			bundle: record.card.bundle,
			revisionId: record.evidence.toolchainRevisionId,
			execution: record.execution,
			task: step.task,
			from: step.from,
			expectedResult: step.result,
			output: { ...record.card.output },
		});
	});
	checkRefs(definition.output.from, "output.from", definition.steps.length);
	definition.steps.forEach((step, index) => {
		if (!used.has(step.id))
			issues.push({
				code: "unused_result",
				path: `steps.${index}`,
				message: `the result of "${step.id}" is used by no later step or output`,
				severity: "warning",
			});
	});

	if (issues.some((issue) => issue.severity === "error"))
		return { ok: false, issues };
	return {
		ok: true,
		definition,
		issues,
		plan: {
			request: definition.request,
			steps,
			output: definition.output,
			catalogVersion: catalog.version,
		},
	};
}
