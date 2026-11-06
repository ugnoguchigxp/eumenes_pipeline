/**
 * The shared front stage of every format parser (plan §10 P0c): model text in, an UNVERIFIED
 * authoring outcome out. A parser only extracts shape; whether a `ready` definition is valid is
 * decided later by the `authoringOutcome` schema and `checkDefinition`, never inside a parser.
 *
 * Outcome discrimination (fixed for the JSON-shaped formats): the top-level `status` field.
 * A definition carries no `status`, so its absence means `ready` and the whole value is the
 * definition; `"ready"` instead names the definition under `definition`.
 */
import { MAX_JSON_DEPTH } from "../../src/contracts/limits.ts";
import type { JsonParseFailure } from "../../src/internal/strict-json.ts";

export type ParsedOutcome =
	| { kind: "ready"; definition: unknown }
	| { kind: "needs_input"; questions: string[]; note?: string }
	| { kind: "unsupported"; reasons: string[] };

/** The library's failure shape, so the strict reader's errors pass through unchanged. */
export type ParseFailure = JsonParseFailure;

export type ParseResult =
	{ ok: true; outcome: ParsedOutcome } | { ok: false; errors: ParseFailure[] };

export type FormatParser = (text: string) => ParseResult;

/** Fixed before comparison (plan §10): inputs and nesting deeper than this are parse failures. */
export const MAX_INPUT_CHARS = 100_000;
export const MAX_DEPTH = MAX_JSON_DEPTH;

export const fail = (
	code: string,
	message: string,
	position?: number,
): ParseResult => ({
	ok: false,
	errors: [{ code, message, ...(position !== undefined ? { position } : {}) }],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] | null =>
	Array.isArray(value) && value.every((v) => typeof v === "string")
		? (value as string[])
		: null;

/** Extract the outcome from an already-parsed JSON-shaped value (JSON and YAML formats share it). */
export function outcomeFromValue(value: unknown): ParseResult {
	if (!isRecord(value))
		return fail("not_an_object", "the top-level value is not an object");
	const own = (key: string): unknown =>
		Object.hasOwn(value, key) ? value[key] : undefined;
	const status = own("status");
	if (status === undefined)
		return { ok: true, outcome: { kind: "ready", definition: value } };
	if (status === "ready") {
		if (!Object.hasOwn(value, "definition"))
			return fail(
				"missing_definition",
				`status "ready" without a "definition" field`,
			);
		return {
			ok: true,
			outcome: { kind: "ready", definition: value.definition },
		};
	}
	if (status === "needs_input") {
		const questions = stringArray(own("questions"));
		if (!questions)
			return fail(
				"invalid_questions",
				`"questions" is not an array of strings`,
			);
		return {
			ok: true,
			outcome: {
				kind: "needs_input",
				questions,
				...(typeof own("note") === "string"
					? { note: own("note") as string }
					: {}),
			},
		};
	}
	if (status === "unsupported") {
		const reasons = stringArray(own("reasons"));
		if (!reasons)
			return fail("invalid_reasons", `"reasons" is not an array of strings`);
		return { ok: true, outcome: { kind: "unsupported", reasons } };
	}
	return fail("unknown_status", `unknown status ${JSON.stringify(status)}`);
}
