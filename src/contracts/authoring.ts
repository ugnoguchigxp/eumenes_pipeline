/**
 * The authoring-side outcome (plan §3): what the composing side hands back for a request — a
 * definition ready to be checked, a request for the missing information, or a statement that
 * no offered component can carry the work.
 *
 * Only `ready` proceeds to `checkDefinition` and execution. The status is the composing side's
 * claim, not a verification: a `ready` definition still goes through `checkDefinition` like any
 * other definition. `needs_input` and `unsupported` never become an execution plan, and an
 * unresolved draft is never dressed up as `ready`.
 */
import { z } from "zod";
import { pipelineDefinition } from "./definition.ts";

const item = z.string().trim().min(1).max(500);

export const authoringOutcome = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("ready"),
		definition: pipelineDefinition,
	}),
	z.strictObject({
		status: z.literal("needs_input"),
		/** What the user must supply before a definition can be completed. */
		questions: z.array(item).min(1).max(8),
		note: item.optional(),
	}),
	z.strictObject({
		status: z.literal("unsupported"),
		/** Why no offered component can carry the request. */
		reasons: z.array(item).min(1).max(8),
	}),
]);
export type AuthoringOutcome = z.infer<typeof authoringOutcome>;
