/**
 * Components: the registered entries a pipeline may use (plan §4).
 *
 * The host builds one `ComponentRecord` per public entry from its registry (Eumenes: the active
 * toolchain revision, its binding and the adapter descriptions; the bench: the catalog snapshot).
 * The composing AI only ever sees `ComponentCard`; the rest is host evidence.
 */

/** Same pattern as Eumenes' toolchain ids (`pipelineDefinitionV1` toolchain step). */
export const ENTRY_PATTERN = /^[a-z][a-z0-9._-]{0,100}$/;

/**
 * The binding's execution kind as Eumenes registers it; `unbound` is a legacy toolchain without a
 * binding revision. The first version runs only `STEP_EXECUTION_KINDS` as steps.
 */
export type ExecutionKind =
	"command" | "instant" | "session" | "task" | "pipeline" | "unbound";
export const STEP_EXECUTION_KINDS: readonly ExecutionKind[] = [
	"command",
	"instant",
	"unbound",
];

/** Where a contract came from. `fixture` is bench-only and never counts as catalog evidence. */
export type ContractOrigin = "catalog" | "eumenes-code" | "fixture" | "missing";

/**
 * `ready`: input and output contracts come from the catalog or Eumenes code.
 * `partial`: offered in the bench with a gap: the output is a bench fixture, or only the summary and
 *   references (no declared output schema). Results on these are reported apart from `ready`.
 * `excluded`: not offered (disabled, hidden dialogue, recursive pipeline, ...); see `reasons`.
 */
export type Support = "ready" | "partial" | "excluded";

/** What the composing AI sees for one entry. Never profiles, skills, tool lists or adapters. */
export type ComponentCard = {
	entry: string;
	/** The bundle that registered the entry; null when the registry links none. */
	bundle: string | null;
	title: string;
	summary: string;
	useWhen: string[];
	avoidWhen: string[];
	/** JSON Schema of typed arguments, only for entries that take them (instant bindings). */
	arguments?: Record<string, unknown>;
	/**
	 * The output contract the catalog declares for this entry. Caution (confirmed in P0a from
	 * the Eumenes code): for command bindings this schema describes the acceptance receipt
	 * (e.g. `{action, jobId}`), not the value a completed step hands on. A job-type entry's
	 * completed output is a domain result record whose schema is not in the catalog; what
	 * later steps actually receive is the summary and the host-issued references.
	 */
	output: { schemaRef: string | null; origin: ContractOrigin };
	/** Whether the entry's operations read only or may also write. */
	effects: Array<"read" | "write">;
	/** The entry may stop to ask the user (binding `questions`). */
	mayAskUser: boolean;
};

/** Host-side record behind a card: support decision, reasons and the registry evidence. */
export type ComponentRecord = {
	card: ComponentCard;
	execution: ExecutionKind;
	enabled: boolean;
	support: Support;
	/** Why the support is what it is; one line each, contract facts only. */
	reasons: string[];
	evidence: {
		toolchainRevisionId: string;
		definitionHash: string | null;
		packageRevisionId: string | null;
		bindingRevisionId: string | null;
		bindingDigest: string | null;
		adapterRef: string | null;
		/** Where `card.bundle` came from; null when nothing in the registry links a bundle. */
		bundleSource: "binding-document" | null;
		toolRevisionIds: string[];
		inputSchemaRefs: string[];
		outputSchemaRef: string | null;
		inputOrigin: ContractOrigin;
	};
};
