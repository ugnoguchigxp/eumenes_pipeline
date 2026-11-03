/**
 * The `json` format: the model answers with one bare JSON document — no prose, no code fence
 * (that is the format's fixed convention; the comparison's prompt states it). The document is
 * read with the strict reader (duplicate keys are errors, never last-wins), then the shared
 * outcome extraction discriminates on the top-level `status`.
 */
import {
	fail,
	MAX_INPUT_CHARS,
	outcomeFromValue,
	type FormatParser,
} from "./outcome.ts";
import { parseJsonStrict } from "./strict-json.ts";

export const parseJsonFormat: FormatParser = (text) => {
	if (text.length > MAX_INPUT_CHARS)
		return fail("too_large", `input longer than ${MAX_INPUT_CHARS} characters`);
	const trimmed = text.trim();
	if (!trimmed) return fail("empty", "empty input");
	const parsed = parseJsonStrict(trimmed);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };
	return outcomeFromValue(parsed.value);
};
