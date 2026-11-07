/** Resolve an exact host revision without consulting deployment state or array order. */
import { createHash } from "node:crypto";

type Definition = {
	kind: string;
	id: string;
	revision: number;
	body?: string;
	packageRevisionId?: string;
	bindingRevisionId?: string;
	profileRevisionId?: string;
	requiredSkillRevisionIds?: string[];
};
export type PromptBundle = {
	bundleId: string;
	definitions: Definition[];
	bindings: Array<{ id: string; revision: number; contractVersion?: string }>;
};
export const revisionId = (d: { kind: string; id: string; revision: number }) =>
	`${d.kind}:${d.id}@${d.revision}`;

export function deriveHostPrompt(
	bundle: PromptBundle,
	selection: {
		toolchainRevisionId?: string;
		expectedInstructionsSha256?: string;
	} = {},
) {
	const byRevision = new Map<string, Definition>();
	for (const definition of bundle.definitions) {
		const id = revisionId(definition);
		if (byRevision.has(id)) throw new Error(`duplicate definition: ${id}`);
		byRevision.set(id, definition);
	}
	const candidates = bundle.definitions.filter(
		(d) => d.kind === "toolchain" && d.id === "pipeline.execute",
	);
	if (selection.toolchainRevisionId === undefined && candidates.length !== 1)
		throw new Error(
			"ambiguous or missing pipeline.execute revision; specify --toolchain-revision",
		);
	const toolchain =
		selection.toolchainRevisionId === undefined
			? candidates[0]
			: candidates.find((d) => revisionId(d) === selection.toolchainRevisionId);
	if (!toolchain)
		throw new Error(
			`unknown pipeline.execute revision: ${selection.toolchainRevisionId}`,
		);
	const requireDefinition = (id: string | undefined, kind: string) => {
		const definition = byRevision.get(id ?? "");
		if (!definition || definition.kind !== kind)
			throw new Error(`missing ${kind} reference: ${id}`);
		return definition;
	};
	const pack = requireDefinition(toolchain.packageRevisionId, "package");
	const profile = requireDefinition(
		pack.profileRevisionId,
		"profile",
	).body?.trim();
	const skills = (pack.requiredSkillRevisionIds ?? []).map((id) =>
		requireDefinition(id, "skill").body?.trim(),
	);
	if (!profile || skills.length === 0 || skills.some((body) => !body))
		throw new Error("profile or skill body missing");
	const bindings = bundle.bindings.filter(
		(b) => `binding:${b.id}@${b.revision}` === toolchain.bindingRevisionId,
	);
	if (bindings.length !== 1)
		throw new Error("missing or ambiguous binding reference");
	const instructions = [profile, ...skills].join("\n\n");
	const instructionsSha256 = createHash("sha256")
		.update(instructions)
		.digest("hex");
	if (
		selection.expectedInstructionsSha256 !== undefined &&
		selection.expectedInstructionsSha256 !== instructionsSha256
	)
		throw new Error("instructions differ from the expected host digest");
	return {
		toolchain,
		pack,
		binding: bindings[0]!,
		instructions,
		instructionsSha256,
	};
}
