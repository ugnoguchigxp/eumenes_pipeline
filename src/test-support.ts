/**
 * Hand-made component records for unit tests of the host-agnostic library (no snapshot needed).
 * Not exported from the package entry.
 */
import type {
	ComponentRecord,
	ExecutionKind,
	Support,
} from "./contracts/component.ts";

export function record(
	entry: string,
	options: {
		bundle?: string | null;
		execution?: ExecutionKind;
		support?: Support;
		output?: string | null;
	} = {},
): ComponentRecord {
	const output = options.output === undefined ? null : options.output;
	return {
		card: {
			entry,
			bundle: options.bundle === undefined ? entry : options.bundle,
			title: entry,
			summary: `${entry} summary`,
			useWhen: [],
			avoidWhen: [],
			output: {
				schemaRef: output,
				origin: output ? "eumenes-code" : "missing",
			},
			effects: ["read"],
			mayAskUser: false,
		},
		execution: options.execution ?? "command",
		enabled: true,
		support: options.support ?? "ready",
		reasons: [],
		evidence: {
			toolchainRevisionId: `toolchain:${entry}@1`,
			definitionHash: null,
			packageRevisionId: null,
			bindingRevisionId: null,
			bindingDigest: null,
			adapterRef: null,
			bundleSource: null,
			toolRevisionIds: [],
			inputSchemaRefs: [],
			outputSchemaRef: output,
			inputOrigin: "eumenes-code",
		},
	};
}
