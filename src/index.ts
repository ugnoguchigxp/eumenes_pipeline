/**
 * eumenes-pipeline public entry. Host-agnostic: no Bun, browser or Eumenes imports, so Eumenes can
 * install the tarball and connect it through a thin adapter (plan §7).
 *
 * Status: P1 — the internal data contract (definition schema, check, catalog resolution,
 * execution plan) is fixed at contract version p0-2. The composing AI's primary description
 * format (JSON) is a separate, still provisional choice: its final confirmation on the weak
 * target model is outstanding and does not change this package's data contract.
 */
export {
	ENTRY_PATTERN,
	STEP_EXECUTION_KINDS,
	type ComponentCard,
	type ComponentRecord,
	type ContractOrigin,
	type ExecutionKind,
	type Support,
} from "./contracts/component.ts";
export {
	MAX_STEPS,
	REQUEST_REF,
	pipelineDefinition,
	pipelineStep,
	type PipelineDefinition,
	type PipelineStep,
} from "./contracts/definition.ts";
export {
	authoringOutcome,
	type AuthoringOutcome,
} from "./contracts/authoring.ts";
export {
	CONTRACT_VERSION,
	documentRecord,
	type DocumentRecord,
} from "./contracts/record.ts";
export {
	STEP_STATES,
	isAdoptable,
	type ReferenceKind,
	type StepExecution,
	type StepReference,
	type StepResult,
	type StepState,
} from "./contracts/execution.ts";
export {
	byCodeUnit,
	createCatalogView,
	type CatalogView,
	type ResolveFailure,
	type Resolved,
} from "./catalog.ts";
export {
	checkDefinition,
	type CheckResult,
	type ExecutionPlan,
	type Issue,
	type IssueCode,
	type PlannedStep,
} from "./check.ts";
export type {
	CancelSignal,
	InferencePort,
	InferenceRequest,
	InferenceResult,
	InferenceUsage,
	PipelineHost,
} from "./ports.ts";
