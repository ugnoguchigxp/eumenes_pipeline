/**
 * The host, not the composing model, owns the user's original request (plan §3). A host that
 * holds the original may bind it into a parsed definition before `checkDefinition`, so a copying
 * slip by the model neither fails the plan nor goes unrecorded: what the model wrote is returned
 * beside the bound definition. Structural only; no meaning is read from either text.
 */
import type { PipelineDefinition } from "./contracts/definition.ts";

export type BoundRequest = {
	/** The definition with `request` replaced by the host-held original. */
	definition: PipelineDefinition;
	/** The request text the model wrote, kept as evidence. */
	written: string;
	/** Whether the model's text was already the exact original. */
	matched: boolean;
};

export function bindSourceRequest(
	definition: PipelineDefinition,
	sourceRequest: string,
): BoundRequest {
	return {
		definition: { ...definition, request: sourceRequest },
		written: definition.request,
		matched: definition.request === sourceRequest,
	};
}
