/**
 * The `free-md` format: a definition written as structured Markdown prose. The convention is
 * fixed here and stated to the composing side verbatim; anything outside it is a parse failure,
 * never a guess.
 *
 * Convention:
 * - `# 依頼` holds the original request text.
 * - `## 手順` holds one NUMBERED item per step, in execution order. Step ids are assigned by
 *   position: `step-1`, `step-2`, ... Inside an item:
 *   - the component is the FIRST backtick-quoted token and must be an entry id (e.g. `web.search`);
 *   - the text before it is the step's label (may be empty), used to reference the step later;
 *   - `(入力: 名前、名前)` lists the materials the step consumes: `依頼` (or `request`) for the
 *     original request, otherwise the label (or id) of an EARLIER step. Unknown names fail;
 *   - `(引数: key=value、...)` gives typed arguments: each value is read as a JSON literal when
 *     it parses as one (`3`, `true`, `"…"`) and as a bare string otherwise. Values cannot
 *     contain `、` or `,` — quote them as JSON strings with other separators inside;
 *   - `(結果: …)` states the expected result; without it the task text doubles as the result;
 *   - the remaining text is the task. Full-width `（…：…）` segments work like half-width ones.
 * - `## 成果物` holds the deliverable description; its `(入力: …)` (same name rules, any step)
 *   fixes `output.from`, which defaults to every step in order.
 * - `## 確認` with at least one line makes the outcome `needs_input` (lines are the questions);
 *   `## 対応不可` with at least one line makes it `unsupported` (lines are the reasons). Both
 *   present is a parse failure. Either one wins over any draft steps: an unresolved draft is
 *   not a ready definition.
 * - A ready document needs `# 依頼`, `## 手順` (≥1 item) and `## 成果物`; anything missing fails.
 */
import { ENTRY_PATTERN } from "../../src/contracts/component.ts";
import { REQUEST_REF } from "../../src/contracts/definition.ts";
import {
	fail,
	MAX_INPUT_CHARS,
	type FormatParser,
	type ParseFailure,
	type ParseResult,
} from "./outcome.ts";
import { parseJsonStrict } from "./strict-json.ts";

function raise(code: string, message: string): never {
	throw { code, message } satisfies ParseFailure;
}

type Sections = Map<string, string[]>;

function splitSections(text: string): Sections {
	const sections: Sections = new Map();
	let current: string[] | null = null;
	for (const line of text.split(/\r?\n/)) {
		const heading = /^(#{1,2})[ \t]+(.+?)[ \t]*$/.exec(line);
		if (heading) {
			const key = `${heading[1]}${(heading[2] as string).trim()}`;
			current = sections.get(key) ?? [];
			sections.set(key, current);
			continue;
		}
		current?.push(line);
	}
	return sections;
}

const nonEmptyLines = (lines: string[] | undefined): string[] =>
	(lines ?? []).map((l) => l.trim()).filter((l) => l.length > 0);

const stripListMarker = (line: string): string =>
	line.replace(/^(?:[-・*]|\d+\s*[.)、])\s*/, "").trim();

function extractSegment(
	text: string,
	label: string,
): { segment: string | null; rest: string } {
	const match = new RegExp(`[（(]\\s*${label}\\s*[:：]\\s*([^）)]*)[）)]`).exec(
		text,
	);
	if (!match) return { segment: null, rest: text };
	return {
		segment: (match[1] as string).trim(),
		rest:
			text.slice(0, match.index) + text.slice(match.index + match[0].length),
	};
}

type StepSoFar = { id: string; label: string };

function resolveNames(segment: string, known: StepSoFar[]): string[] {
	const names = segment
		.split(/[、,，]/)
		.map((n) => n.trim())
		.filter((n) => n.length > 0);
	return names.map((name) => {
		if (name === "依頼" || name === REQUEST_REF) return REQUEST_REF;
		const step = known.find((s) => s.label === name || s.id === name);
		if (!step)
			raise("unknown_input", `入力の名前 "${name}" が前の手順に見つからない`);
		return step.id;
	});
}

function parseArguments(segment: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const pair of segment.split(/[、,]/)) {
		const eq = pair.indexOf("=");
		if (eq < 0) raise("invalid_arguments", `引数 "${pair.trim()}" に = がない`);
		const key = pair.slice(0, eq).trim();
		const raw = pair.slice(eq + 1).trim();
		if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key))
			raise("invalid_arguments", `引数名 "${key}" が不正`);
		if (!raw) raise("invalid_arguments", `引数 "${key}" の値が空`);
		if (Object.hasOwn(out, key))
			raise("invalid_arguments", `引数 "${key}" が重複している`);
		const parsed = parseJsonStrict(raw);
		out[key] =
			parsed.ok &&
			(parsed.value === null ||
				typeof parsed.value === "string" ||
				typeof parsed.value === "number" ||
				typeof parsed.value === "boolean")
				? parsed.value
				: raw;
	}
	return out;
}

type ParsedStep = {
	id: string;
	label: string;
	definition: Record<string, unknown>;
};

function parseItem(
	text: string,
	index: number,
	known: StepSoFar[],
): ParsedStep {
	const id = `step-${index + 1}`;
	let entry: string | null = null;
	let entryStart = -1;
	let entryEnd = -1;
	for (const token of text.matchAll(/`([^`]+)`/g)) {
		if (ENTRY_PATTERN.test(token[1] as string)) {
			entry = token[1] as string;
			entryStart = token.index;
			entryEnd = token.index + token[0].length;
			break;
		}
	}
	if (entry === null)
		raise(
			"item_without_entry",
			`手順${index + 1}に部品（バッククォートの入口ID）がない`,
		);
	const label = text
		.slice(0, entryStart)
		.trim()
		.replace(/[:：]\s*$/, "")
		.trim();
	if (label && known.some((s) => s.label === label))
		raise("duplicate_label", `手順のラベル "${label}" が重複している`);
	let rest = text.slice(entryEnd);
	const inputs = extractSegment(rest, "入力");
	rest = inputs.rest;
	const args = extractSegment(rest, "引数");
	rest = args.rest;
	const result = extractSegment(rest, "結果");
	rest = result.rest;
	const task = rest
		.trim()
		.replace(/^[:：]\s*/, "")
		.trim();
	if (!task) raise("item_without_task", `手順${index + 1}に作業内容がない`);
	const step: Record<string, unknown> = {
		id,
		bundle: entry,
		task,
		from: inputs.segment === null ? [] : resolveNames(inputs.segment, known),
		...(args.segment === null
			? {}
			: { arguments: parseArguments(args.segment) }),
		result: result.segment ?? task,
	};
	return { id, label, definition: step };
}

export const parseFreeMd: FormatParser = (text) => {
	if (text.length > MAX_INPUT_CHARS)
		return fail("too_large", `input longer than ${MAX_INPUT_CHARS} characters`);
	try {
		return parse(text);
	} catch (error) {
		const failure = error as ParseFailure;
		if (failure && typeof failure.code === "string")
			return { ok: false, errors: [failure] };
		throw error;
	}
};

function parse(text: string): ParseResult {
	const sections = splitSections(text);
	const questions = nonEmptyLines(sections.get("##確認")).map(stripListMarker);
	const reasons = nonEmptyLines(sections.get("##対応不可")).map(
		stripListMarker,
	);
	if (questions.length > 0 && reasons.length > 0)
		raise("ambiguous_state", "## 確認 と ## 対応不可 が両方ある");
	if (questions.length > 0)
		return { ok: true, outcome: { kind: "needs_input", questions } };
	if (reasons.length > 0)
		return { ok: true, outcome: { kind: "unsupported", reasons } };

	const request = nonEmptyLines(sections.get("#依頼")).join("\n");
	if (!request) raise("missing_request", "# 依頼 がない、または空");
	const itemLines = nonEmptyLines(sections.get("##手順")).filter((line) =>
		/^\d+\s*(?:[.)]|、)/.test(line),
	);
	if (itemLines.length === 0)
		raise("missing_steps", "## 手順 に番号付き項目がない");
	const known: StepSoFar[] = [];
	const steps = itemLines.map((line, index) => {
		const itemText = line.replace(/^\d+\s*(?:[.)]|、)\s*/, "");
		const step = parseItem(itemText, index, known);
		known.push({ id: step.id, label: step.label });
		return step.definition;
	});

	const outputLines = sections.get("##成果物");
	if (!outputLines) raise("missing_output", "## 成果物 がない");
	const outputText = outputLines.join("\n");
	const outputInputs = extractSegment(outputText, "入力");
	const deliver = outputInputs.rest.trim();
	if (!deliver) raise("missing_output", "## 成果物 に提示内容がない");
	const outputFrom =
		outputInputs.segment === null
			? known.map((s) => s.id)
			: resolveNames(outputInputs.segment, known);

	return {
		ok: true,
		outcome: {
			kind: "ready",
			definition: {
				request,
				steps,
				output: { from: outputFrom, deliver },
			},
		},
	};
}
