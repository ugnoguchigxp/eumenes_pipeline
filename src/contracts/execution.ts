/**
 * The host contract for executing one pipeline step.
 *
 * It mirrors the subset of Eumenes' tool-runtime contracts a step needs
 * (`api/domains/tool-runtime/contracts/task-execution.ts`: `ChildExecution`, `ChildResult`,
 * `ExecutionReference`), so the Eumenes adapter maps it field by field and the bench mock host
 * implements the very same shape. A step is one child execution of a registered toolchain entry;
 * the toolchain's own agent and adapters stay hidden behind it (plan §4, §5).
 */

/** `ChildResult.state` in Eumenes. Only `completed` may be handed to later steps. */
export const STEP_STATES = [
	"running",
	"waiting_input",
	"completed",
	"failed",
	"cancelled",
	"expired",
	"indeterminate",
	"handoff",
] as const;
export type StepState = (typeof STEP_STATES)[number];

/** `ExecutionReference.kind` in Eumenes. */
export type ReferenceKind =
	"message" | "memory" | "world" | "result" | "artifact" | "resource";

/** A host-issued reference (`ExecutionReference`); never reconstructed from model prose. */
export type StepReference = {
	ref: string;
	owner: string;
	id: string;
	revision: string;
	digest: string;
	label: string;
	kind: ReferenceKind;
	preview: string;
};

/** What the host receives for one step (`ChildExecution`, reduced to what a step decides). */
export type StepExecution = {
	runId: string;
	stepId: string;
	/** The public entry (toolchain id) the definition resolved to. */
	entry: string;
	/** The entry's revision, fixed when the run started. */
	revisionId: string;
	/** The step's task, handed to the entry as its request. */
	request: string;
	/** Typed arguments, only for entries that declare them (instant bindings). */
	arguments?: Record<string, unknown>;
	/** Host-resolved references for the step's `from` (the request and earlier results). */
	references: StepReference[];
	/** The user's original request; kept unchanged for the whole run. */
	source: { request: string; digest: string };
	/** Epoch milliseconds after which a result must not be adopted. */
	deadline: number;
};

/** What the host returns for one step (`ChildResult`). */
export type StepResult = {
	state: StepState;
	summary: string;
	output?: unknown;
	code?: string;
	/** Set with `waiting_input`: what the entry asks the user. */
	question?: string;
	references: StepReference[];
	links?: string[];
	modelCalls: number;
};

/** Only a confirmed completion is handed on; acceptance, waiting or partial work never is. */
export const isAdoptable = (result: StepResult): boolean =>
	result.state === "completed";
