import { z } from "zod";
import { ENTRY_PATTERN } from "../contracts/component.ts";
import { MAX_STEPS } from "../contracts/limits.ts";
import { boundedArguments } from "./json.ts";
import type { JsonValue } from "../contracts/definition.ts";

const stepId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const reference = z.string().min(1).max(40);

export const pipelineStepSchema = z.strictObject({
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
		.custom<Record<string, JsonValue>>(boundedArguments, {
			message:
				"arguments must be literal JSON: at most 32 keys, depth 64, 10000 nodes and 100000 text units; no cycles or accessors",
		})
		.transform(
			(value) => JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>,
		)
		.optional(),
	/** Natural-language description of the wanted result; not a type, not a promise. */
	result: z.string().trim().min(1).max(500),
});

export const pipelineDefinitionSchema = z.strictObject({
	/** The user's request verbatim (not trimmed: kept as the original text). */
	request: z.string().min(1).max(8000),
	steps: z.array(pipelineStepSchema).min(1).max(MAX_STEPS),
	output: z.strictObject({
		from: z
			.array(reference)
			.min(1)
			.max(MAX_STEPS + 1),
		deliver: z.string().trim().min(1).max(1000),
	}),
});

const item = z.string().trim().min(1).max(500);

export const authoringOutcomeSchema = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("ready"),
		definition: pipelineDefinitionSchema,
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

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInt = z.number().int().positive();

export const documentRecordSchema = z.strictObject({
	/** The description format the document text is written in (e.g. a bench format id). */
	formatId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
	contractVersion: z.string().min(1).max(40),
	/** Document version; the original is 1 and each revision increments it. */
	documentVersion: positiveInt,
	/** SHA-256 of the document text as written, lowercase hex. */
	documentDigest: digest,
	/** SHA-256 of the user's original request text, lowercase hex. */
	sourceRequestDigest: digest,
	/** The catalog version the document was checked against. */
	catalogVersion: z.string().min(1).max(80),
	/** The document version this one revises, when it is a revision. */
	revisionOf: positiveInt.optional(),
});
