/**
 * eumenes-pipeline public entry. Host-agnostic: no Bun, browser or Eumenes imports, so Eumenes can
 * install the tarball and connect it through a thin adapter (plan §7).
 *
 * Status: the internal data contract (definition schema, check, catalog resolution, execution
 * plan) is fixed at contract version p0-3. Package 0.1.0 adds host-side hardening without changing
 * that data shape: the strict JSON reader, request binding, and the runnable check that a host
 * view cannot widen. The composing prompt stays the host's (Eumenes keeps it as bundle data); its
 * confirmation on the weak target model is outstanding and does not change this data contract.
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
	isRunnable,
	type CatalogView,
	type ResolveFailure,
	type Resolved,
} from "./catalog.ts";
export {
	checkDefinition,
	type CheckContext,
	type CheckResult,
	type ExecutionPlan,
	type Issue,
	type IssueCode,
	type PlannedStep,
} from "./check.ts";
export { bindSourceRequest, type BoundRequest } from "./source-request.ts";
export {
	parseJsonStrict,
	type JsonParseFailure,
	type StrictJsonResult,
} from "./internal/strict-json.ts";
export { MAX_JSON_DEPTH } from "./contracts/limits.ts";
export type {
	CancelSignal,
	InferencePort,
	InferenceRequest,
	InferenceResult,
	InferenceUsage,
	PipelineHost,
} from "./ports.ts";

export type {
	Schema,
	ValidationIssue,
	ValidationError,
	ValidationResult,
} from "./contracts/schema.ts";
