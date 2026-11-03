/**
 * The `md-yaml` format: Markdown carrying exactly one ```yaml fence with the restricted YAML
 * (plan §10): plain data only — mappings, sequences, strings, numbers, booleans, null.
 *
 * Fixed conventions:
 * - Exactly one fence tagged `yaml` or `yml` must be present. None, several, or an unclosed
 *   fence are parse failures. Fences of other languages are ignored.
 * - Anchors, aliases, merge keys (`<<`), explicit tags (even standard ones like `!!str`) and
 *   duplicate keys are rejected: the AST is walked node by node and the value is rebuilt from
 *   it, so nothing the `yaml` package would silently resolve or drop reaches the outcome.
 *   Non-string keys and non-finite numbers (`.inf`, `.nan`) are rejected as well.
 * - The YAML stream must hold a single document (the package reports `MULTIPLE_DOCS`).
 */
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import {
	fail,
	MAX_DEPTH,
	MAX_INPUT_CHARS,
	outcomeFromValue,
	type FormatParser,
	type ParseFailure,
} from "./outcome.ts";

type FenceBlock = { lang: string; lines: string[]; closed: boolean };

function extractFences(text: string): FenceBlock[] {
	const blocks: FenceBlock[] = [];
	let current: FenceBlock | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (current) {
			if (/^```\s*$/.test(line)) {
				current.closed = true;
				blocks.push(current);
				current = null;
			} else current.lines.push(line);
		} else {
			const open = /^```\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
			if (open)
				current = {
					lang: (open[1] ?? "").toLowerCase(),
					lines: [],
					closed: false,
				};
		}
	}
	if (current) blocks.push(current);
	return blocks;
}

function raise(code: string, message: string): never {
	throw { code, message } satisfies ParseFailure;
}

/** Rebuild a JSON-shaped value from a YAML AST node, rejecting everything restricted. */
function convert(node: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) raise("too_deep", `nesting deeper than ${MAX_DEPTH}`);
	if (node === null || node === undefined) return null;
	if (typeof node !== "object")
		raise("unsupported_node", "unexpected YAML node");
	if (isAlias(node))
		raise("alias", "aliases (*) are not allowed in restricted YAML");
	const tagged = node as { anchor?: string; tag?: string };
	if (tagged.anchor !== undefined)
		raise("anchor", "anchors (&) are not allowed in restricted YAML");
	if (tagged.tag !== undefined)
		raise(
			"tag",
			`explicit tags (${tagged.tag}) are not allowed in restricted YAML`,
		);
	if (isMap(node)) {
		const out: Record<string, unknown> = {};
		for (const pair of node.items) {
			const key = pair.key;
			if (isAlias(key))
				raise("alias", "aliases (*) are not allowed in restricted YAML");
			const keyMeta = key as { anchor?: string; tag?: string };
			if (keyMeta.anchor !== undefined)
				raise("anchor", "anchors (&) are not allowed in restricted YAML");
			if (keyMeta.tag !== undefined)
				raise("tag", "explicit tags are not allowed in restricted YAML");
			if (!isScalar(key) || typeof key.value !== "string")
				raise("non_string_key", "mapping keys must be plain strings");
			if (key.value === "<<")
				raise("merge_key", "merge keys (<<) are not allowed");
			if (Object.hasOwn(out, key.value))
				raise("duplicate_key", `duplicate key ${JSON.stringify(key.value)}`);
			out[key.value] = convert(pair.value, depth + 1);
		}
		return out;
	}
	if (isSeq(node)) return node.items.map((item) => convert(item, depth + 1));
	if (isScalar(node)) {
		const value = node.value;
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		)
			return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value))
				raise("non_finite", "non-finite numbers are not JSON values");
			return value;
		}
		raise("unsupported_scalar", `unsupported scalar value ${String(value)}`);
	}
	raise("unsupported_node", "unexpected YAML node");
}

export const parseMdYaml: FormatParser = (text) => {
	if (text.length > MAX_INPUT_CHARS)
		return fail("too_large", `input longer than ${MAX_INPUT_CHARS} characters`);
	const yamlBlocks = extractFences(text).filter(
		(b) => b.lang === "yaml" || b.lang === "yml",
	);
	if (yamlBlocks.some((b) => !b.closed))
		return fail("unclosed_fence", "a yaml fence is never closed");
	if (yamlBlocks.length === 0)
		return fail("no_yaml_fence", "no ```yaml fence found");
	if (yamlBlocks.length > 1)
		return fail(
			"multiple_yaml_fences",
			`${yamlBlocks.length} yaml fences found; exactly one is required`,
		);
	const source = (yamlBlocks[0] as FenceBlock).lines.join("\n");
	const doc = parseDocument(source, { uniqueKeys: true });
	if (doc.errors.length > 0) {
		const errors: ParseFailure[] = doc.errors.map((error) => ({
			code: error.code === "DUPLICATE_KEY" ? "duplicate_key" : "invalid_yaml",
			message: error.message.split("\n")[0] as string,
		}));
		return { ok: false, errors };
	}
	try {
		return outcomeFromValue(convert(doc.contents, 0));
	} catch (error) {
		const failure = error as ParseFailure;
		if (failure && typeof failure.code === "string")
			return { ok: false, errors: [failure] };
		throw error;
	}
};
