/**
 * The short pipeline definition (plan §3): `request`, `steps`, `output`.
 *
 * Fixed in P1 at contract version p0-2. This is the shared internal data structure every
 * description format (JSON, YAML) is parsed into before checking; field or limit changes need
 * a contract version bump. Formats never get their own schema: a parser yields `unknown`, and
 * `checkDefinition` decides.
 */
import { z } from "zod";
import { ENTRY_PATTERN } from "./component.ts";

/** Reserved reference to the user's original request; never a step id. */
export const REQUEST_REF = "request";
/** Same upper bound as Eumenes' current pipelines (`PIPELINE_MAX_STEPS`). P0 fixes the first-version limit. */
export const MAX_STEPS = 8;

const stepId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const reference = z.string().min(1).max(40);

export const pipelineStep = z.strictObject({
	id: stepId,
	/** The component identifier from the cards shown to the composing AI. */
	bundle: z.string().regex(ENTRY_PATTERN),
	/** The public entry, when the bundle offers several (plan §4: explicit, never implicit). */
	entry: z.string().regex(ENTRY_PATTERN).optional(),
	task: z.string().trim().min(1).max(2000),
	/** The request and/or earlier steps whose whole result this step gets. No expressions. */
	from: z.array(reference).max(MAX_STEPS + 1),
	/**
	 * Typed arguments for an entry that declares them (instant bindings): literal JSON values
	 * only, never expressions. Choosing the values is the composing AI's semantic judgement;
	 * checking them against the entry's declared schema is code's job (plan §5). When omitted,
	 * the entry structures its arguments from the task and the handed-on materials itself.
	 */
	arguments: z
		.record(z.string(), z.json())
		.refine((value) => Object.keys(value).length <= 32, {
			message: "at most 32 argument keys",
		})
		.optional(),
	/** Natural-language description of the wanted result; not a type, not a promise. */
	result: z.string().trim().min(1).max(500),
});
export type PipelineStep = z.infer<typeof pipelineStep>;

export const pipelineDefinition = z.strictObject({
	/** The user's request verbatim (not trimmed: kept as the original text). */
	request: z.string().min(1).max(8000),
	steps: z.array(pipelineStep).min(1).max(MAX_STEPS),
	output: z.strictObject({
		from: z
			.array(reference)
			.min(1)
			.max(MAX_STEPS + 1),
		deliver: z.string().trim().min(1).max(1000),
	}),
});
export type PipelineDefinition = z.infer<typeof pipelineDefinition>;
