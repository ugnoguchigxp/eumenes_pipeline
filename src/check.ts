/**
 * Structural check of a parsed definition against the offered catalog, producing the execution
 * plan the host runs (plan §3, §5). Code checks schema, references, order and contracts only; it
 * never judges whether a step fits the request (that is the LLM's and the evaluator's job).
 */
import { z } from "zod";
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
	| "unexpected_arguments"
	| "invalid_arguments"
	| "arguments_unchecked"
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
	/** Typed arguments the definition states for the entry, carried verbatim (plan §5). */
	arguments?: Record<string, unknown>;
	expectedResult: string;
	/**
	 * The catalog-declared output contract for the entry. For command bindings this is the
	 * acceptance receipt's schema, not the completed output's (P0a, confirmed from the
	 * Eumenes code): the host hands on the summary and references, and validates a completed
	 * output against this schema only where the entry's route actually returns one.
	 */
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

type ArgumentsCheck =
	{ kind: "ok" } | { kind: "invalid"; detail: string } | { kind: "unchecked" };

/**
 * Type-check stated arguments against the entry's declared JSON Schema, the same way the bench
 * validates contract values (`z.fromJSONSchema`). A schema whose constructs the converter does
 * not support is reported as `unchecked`, never silently passed.
 */
function checkArguments(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
): ArgumentsCheck {
	let validator: z.ZodType;
	try {
		validator = z.fromJSONSchema(
			schema as Parameters<typeof z.fromJSONSchema>[0],
		);
	} catch {
		return { kind: "unchecked" };
	}
	const result = validator.safeParse(value);
	if (result.success) return { kind: "ok" };
	const detail = result.error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
	return { kind: "invalid", detail };
}

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
		if (step.arguments !== undefined) {
			const argsSchema = record.card.arguments;
			if (!argsSchema)
				error(
					"unexpected_arguments",
					`steps.${index}.arguments`,
					`${record.card.entry} declares no arguments schema`,
				);
			else {
				const checked = checkArguments(argsSchema, step.arguments);
				if (checked.kind === "unchecked")
					issues.push({
						code: "arguments_unchecked",
						path: `steps.${index}.arguments`,
						message: `the arguments schema of ${record.card.entry} uses constructs this checker cannot validate; the arguments were not type-checked`,
						severity: "warning",
					});
				else if (checked.kind === "invalid")
					error(
						"invalid_arguments",
						`steps.${index}.arguments`,
						`arguments do not satisfy the schema of ${record.card.entry}: ${checked.detail}`,
					);
			}
		}
		steps.push({
			stepId: step.id,
			entry: record.card.entry,
			bundle: record.card.bundle,
			revisionId: record.evidence.toolchainRevisionId,
			execution: record.execution,
			task: step.task,
			from: step.from,
			...(step.arguments !== undefined ? { arguments: step.arguments } : {}),
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
