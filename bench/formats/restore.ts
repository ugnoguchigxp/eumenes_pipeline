/**
 * Deterministic JSON syntax restore (opt-in bench stage, plan §10 follow-up): when the
 * `json` format's STRICT parser rejects a model output, a repair library gets exactly one
 * chance to make the text parseable, and the restored text must pass the SAME strict
 * parser — duplicate keys, trailing content, depth and every other strictness rule still
 * apply to the restored text, so restore can never smuggle an ambiguous document past
 * the gate. It only undoes surface syntax damage of the kind a weak model produces:
 * trailing commas, code fences, single quotes, unquoted keys, comments, missing closing
 * brackets, strings cut short. It never invents content: a document truncated mid-way
 * parses as the truncated document and fails (or passes) the later gates on its own
 * merits.
 *
 * Engine: the OSS library `jsonrepair` (josdejong), pinned in devDependencies. Two of
 * its behaviours are load-bearing and pinned by `restore.test.ts`: it preserves
 * duplicate keys in its output (so the strict reader still rejects them), and it throws
 * on text it cannot interpret as JSON at all (prose around a document is NOT silently
 * stripped).
 *
 * The raw output remains the evidence: recordings are never rewritten, and a caller
 * records per attempt whether restore was offered and whether it recovered the parse,
 * so the raw parse rate stays separable from the restored one.
 */
import { jsonrepair } from "jsonrepair";
import { parseJsonFormat } from "./json.ts";
import type { ParseResult } from "./outcome.ts";

/** The restore engine recorded in a run's config when the stage is enabled. */
export const RESTORE_ENGINE = "jsonrepair@3.15.0";

export type RestoredParse = {
	/** The parse that evaluation continues with: the restored parse when recovered, else the raw failure. */
	result: ParseResult;
	/** The strict parser failed on the raw text and restore was offered. */
	attempted: boolean;
	/** The restored text passed the strict parser; `result` is that parse. */
	restored: boolean;
};

/**
 * Strict parse first; only on failure, one deterministic restore and a strict re-parse
 * of the restored text. When restore cannot recover the parse, the RAW failure is
 * returned unchanged — error codes and positions keep describing the model's own text,
 * never the restorer's.
 */
export function parseJsonWithRestore(text: string): RestoredParse {
	const raw = parseJsonFormat(text);
	if (raw.ok) return { result: raw, attempted: false, restored: false };
	let repaired: string;
	try {
		repaired = jsonrepair(text);
	} catch {
		return { result: raw, attempted: true, restored: false };
	}
	if (repaired === text)
		return { result: raw, attempted: true, restored: false };
	const reparsed = parseJsonFormat(repaired);
	if (!reparsed.ok) return { result: raw, attempted: true, restored: false };
	return { result: reparsed, attempted: true, restored: true };
}
