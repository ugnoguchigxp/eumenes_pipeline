/**
 * P0a inventory: one `ComponentRecord` per toolchain in the snapshot, with the support decision and
 * its reasons taken from contract facts only (execution kind, binding, adapter, schema refs). Nothing
 * here reads titles or summaries to decide anything; ambiguous cases are recorded, not guessed.
 *
 * The same shape is what the Eumenes adapter will build from the live registry.
 */
import {
	STEP_EXECUTION_KINDS,
	type ComponentRecord,
	type ContractOrigin,
	type ExecutionKind,
	type Support,
} from "../../src/contracts/component.ts";
import type { ContractSet, JsonSchema } from "./contracts.ts";
import type { Snapshot } from "./snapshot.ts";

type ToolchainDefinition = {
	id: string;
	title: string;
	summary: string;
	useWhen?: string[];
	avoidWhen?: string[];
	packageRevisionId?: string;
	bindingRevisionId?: string;
};
type BindingDocument = {
	execution: Exclude<ExecutionKind, "unbound">;
	adapterRef: string;
	tools?: Array<{
		toolRevisionId: string;
		operationId: string;
		inputSchemaRef: string;
	}>;
	outputSchemaRef?: string;
	questions?: unknown[];
};
type PackageDefinition = { toolRevisionIds?: string[] };
type ToolDefinition = { schemaKey?: string };

/** Adapter whose entries start a task pipeline; using one inside a pipeline would recurse (plan §4). */
export const PIPELINE_ADAPTER_REF = "adapter:pipelines@1";

const strongest = (origins: ContractOrigin[]): ContractOrigin => {
	if (origins.length === 0 || origins.includes("missing")) return "missing";
	if (origins.includes("fixture")) return "fixture";
	if (origins.includes("eumenes-code")) return "eumenes-code";
	return "catalog";
};

export function buildInventory(
	snapshot: Snapshot,
	contracts: ContractSet,
): ComponentRecord[] {
	return snapshot.items("toolchain").map((item) => {
		const revision = snapshot.revision<ToolchainDefinition>(
			item.activeRevisionId,
		);
		if (!revision)
			throw new Error(`active revision missing: ${item.activeRevisionId}`);
		const def = revision.definition;
		const reasons: string[] = [];
		const binding = def.bindingRevisionId
			? snapshot.document<BindingDocument>(def.bindingRevisionId)
			: null;
		if (def.bindingRevisionId && !binding)
			reasons.push(
				`binding document ${def.bindingRevisionId} is not in the snapshot`,
			);

		const execution: ExecutionKind = binding
			? binding.document.execution
			: "unbound";
		const adapterRef = binding?.document.adapterRef ?? null;
		const adapter = adapterRef ? contracts.adapter(adapterRef) : undefined;

		// Inputs: the binding's tool schema refs, or for a legacy toolchain its package tools' schema keys.
		let toolRevisionIds: string[];
		let inputSchemaRefs: string[];
		if (binding) {
			toolRevisionIds = (binding.document.tools ?? []).map(
				(t) => t.toolRevisionId,
			);
			inputSchemaRefs = (binding.document.tools ?? []).map(
				(t) => t.inputSchemaRef,
			);
		} else {
			const pkg = def.packageRevisionId
				? snapshot.revision<PackageDefinition>(def.packageRevisionId)
				: null;
			toolRevisionIds = pkg?.definition.toolRevisionIds ?? [];
			inputSchemaRefs = toolRevisionIds.flatMap((id) => {
				const key = snapshot.revision<ToolDefinition>(id)?.definition.schemaKey;
				return key ? [`builtin:${key}`] : [];
			});
			reasons.push(
				"no binding revision (legacy toolchain): execution contract and effects are not declared",
			);
		}
		const unresolvedInputs = inputSchemaRefs.filter(
			(ref) => contracts.origin(ref) === "missing",
		);
		for (const ref of unresolvedInputs)
			reasons.push(`input schema ${ref} is not resolvable`);
		const inputOrigin = strongest(
			inputSchemaRefs.map((ref) => contracts.origin(ref)),
		);

		// Output: the binding's declared schema, else a bench fixture, else summary/references only.
		let outputRef: string | null = binding?.document.outputSchemaRef ?? null;
		let outputOrigin: ContractOrigin = outputRef
			? contracts.origin(outputRef)
			: "missing";
		if (outputRef && outputOrigin === "missing")
			reasons.push(`output schema ${outputRef} is not resolvable`);
		if (!outputRef) {
			const fixture = contracts.fixtureOutput(item.id);
			if (fixture) {
				outputRef = fixture;
				outputOrigin = contracts.origin(fixture);
				reasons.push(
					`output contract is the bench fixture ${fixture}${contracts.fixturesReviewed ? "" : " (unreviewed)"}`,
				);
			} else
				reasons.push(
					"no output schema declared: a completed step hands on its summary and references only",
				);
		}
		if (execution === "command" && outputRef?.startsWith("domain:"))
			reasons.push(
				`output ${outputRef} is the accepted operation's receipt; the completed work's content is not in the catalog`,
			);

		const effects = new Set<"read" | "write">();
		if (binding && adapter?.operations) {
			const ops = new Set(binding.document.tools?.map((t) => t.operationId));
			for (const op of adapter.operations)
				if (ops.has(op.operationId)) effects.add(op.effect);
		}
		if (binding && !adapter)
			reasons.push(`adapter ${adapterRef} has no extracted description`);

		const bundle = binding?.bundleId ?? null;
		if (!bundle)
			reasons.push("no bundle document links this entry: bundle is unknown");

		const excludedBy: string[] = [];
		if (!item.enabled) excludedBy.push("disabled in the registry");
		if (execution === "session")
			excludedBy.push(
				"session binding: needs a continuing dialogue that a step would hide (plan §4, §12)",
			);
		if (adapterRef === PIPELINE_ADAPTER_REF || execution === "pipeline")
			excludedBy.push(
				"pipeline entry: using it inside a pipeline would recurse (plan §4)",
			);
		if (
			!STEP_EXECUTION_KINDS.includes(execution) &&
			execution !== "session" &&
			execution !== "pipeline"
		)
			excludedBy.push(
				`execution kind "${execution}" is outside the first version's step contract (${STEP_EXECUTION_KINDS.join(", ")})`,
			);
		reasons.unshift(...excludedBy);

		const support: Support =
			excludedBy.length > 0
				? "excluded"
				: (inputOrigin === "eumenes-code" || inputOrigin === "catalog") &&
					  (outputOrigin === "eumenes-code" || outputOrigin === "catalog")
					? "ready"
					: "partial";

		let args: JsonSchema | undefined;
		if (execution === "instant") {
			const ref = inputSchemaRefs[0];
			args = ref ? contracts.schema(ref) : undefined;
			if (inputSchemaRefs.length !== 1)
				reasons.push(
					`instant binding with ${inputSchemaRefs.length} tools: arguments contract is ambiguous`,
				);
		}

		return {
			card: {
				entry: item.id,
				bundle,
				title: def.title,
				summary: def.summary,
				useWhen: def.useWhen ?? [],
				avoidWhen: def.avoidWhen ?? [],
				...(args ? { arguments: args } : {}),
				output: { schemaRef: outputRef, origin: outputOrigin },
				effects: [...effects].sort(),
				mayAskUser: (binding?.document.questions?.length ?? 0) > 0,
			},
			execution,
			enabled: item.enabled,
			support,
			reasons,
			evidence: {
				toolchainRevisionId: revision.id,
				definitionHash: revision.definitionHash,
				packageRevisionId: def.packageRevisionId ?? null,
				bindingRevisionId: def.bindingRevisionId ?? null,
				bindingDigest: binding?.digest ?? null,
				adapterRef,
				bundleSource: bundle ? "binding-document" : null,
				toolRevisionIds,
				inputSchemaRefs,
				outputSchemaRef: outputRef,
				inputOrigin,
			},
		} satisfies ComponentRecord;
	});
}

export type InventorySummary = {
	total: number;
	enabled: number;
	ready: string[];
	partial: string[];
	excluded: string[];
	/** Offered share of enabled toolchains, with and without fixtures. */
	coverage: { ready: number; withFixtures: number };
};

export function summarize(records: ComponentRecord[]): InventorySummary {
	const pick = (support: Support) =>
		records.filter((r) => r.support === support).map((r) => r.card.entry);
	const enabled = records.filter((r) => r.enabled).length;
	const ready = pick("ready");
	const partial = pick("partial");
	return {
		total: records.length,
		enabled,
		ready,
		partial,
		excluded: pick("excluded"),
		coverage: {
			ready: enabled ? ready.length / enabled : 0,
			withFixtures: enabled ? (ready.length + partial.length) / enabled : 0,
		},
	};
}
