/** A ready claim still needs structural checking, host authorization and confirmed execution. */
import { authoringOutcomeSchema } from "../internal/schemas.ts";
import type { PipelineDefinition } from "./definition.ts";
import type { Schema } from "./schema.ts";
export type AuthoringOutcome =
	| { status: "ready"; definition: PipelineDefinition }
	| { status: "needs_input"; questions: string[]; note?: string }
	| { status: "unsupported"; reasons: string[] };
export const authoringOutcome: Schema<AuthoringOutcome> =
	authoringOutcomeSchema;
