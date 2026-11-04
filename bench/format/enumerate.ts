/**
 * Stage A of the staged-generation condition (the user's direction, 2026-11-04:
 * long workflows are generated in stages, with a review of whether the result
 * covers what was asked — never one-shot). Before composing, a short separate
 * generation enumerates ONLY the work items the request asks for, as paraphrases
 * in request order. The bench assigns each item a stable id (`w1`, `w2`, …) by
 * position, so the id linkage the later stages rely on cannot break on the
 * model's own id formatting — the same mechanical failure class this bench keeps
 * removing from the model (step ids, JSON syntax).
 *
 * Stage B (the composing prompt, see `enumNoteText`) hands the item list to the
 * composer, which marks each step's `task` head with the ids it covers
 * (`[w1]`, `[w1][w2]`). Stage C is deterministic: the set difference between the
 * enumerated ids and the ids the steps cite is the coverage gap, and each
 * uncovered item becomes a machine error for the one coverage-repair round
 * (`bench/format/run.ts`). Markers are a bench-side auxiliary channel only: the
 * evaluator strips them from the parsed definition before authoring, checking
 * and scoring, and the definition contract (`src/`) never sees them.
 *
 * Fairness: the enumeration prompt is built from the case's request and provided
 * materials alone — no cards, no entry names, no expected values, no case notes
 * (the triage pre-pass rule). The output is parsed with the strict JSON reader;
 * anything that is not exactly the item-list shape is an invalid enumeration,
 * recorded as such, never guessed at.
 */
import type { EvalCase } from "../cases/cases.ts";
import { parseJsonStrict } from "../formats/strict-json.ts";

/** The enumeration template recorded in a staged run's config. */
export const ENUM_TEMPLATE_VERSION = "enum-v1";

/** One enumerated work item: a bench-assigned id and the model's paraphrase. */
export type WorkItem = { id: string; text: string };

/** The concluded stage-A output of one case: its items, in request order. */
export type EnumConclusion = { items: WorkItem[] };

/** More items than this is not an enumeration but a retelling; refused as invalid. */
export const MAX_ENUM_ITEMS = 16;

const ENUM_SYSTEM = `あなたは、依頼を受けて手順定義を作る前段で、その依頼に含まれる作業を列挙する担当です。

進め方:
- 依頼文を読み、利用者が求めている作業を、漏れなく、文に現れる順序のまま項目として挙げてください。
- 1つの項目は1つの作業にしてください。「調べて、作って、届ける」のように複数の作業が1文に含まれていれば、別々の項目に分けます。
- 調べる・作る・書く・記録する・設定する・届ける（知らせる）といった作業は、文の末尾にあるものや、短く触れられているだけのものも、すべて項目にしてください。
- 挙げるのは作業の言い換えだけです。使う部品や入口の名前、手順の組み立て方、届け方の文章は書かないでください。
- 依頼の対象が特定できるかどうかは判定しません。情報が足りないように見えても、求められている作業そのものを挙げてください。
- 出力は1つの素のJSON文書だけにしてください。前後の文章や説明は付けないでください: {"items": ["作業の言い換え", ...]}（items は1件以上）`;

/** The one enumeration prompt of a case: its request and materials, nothing else. */
export function buildEnumPrompt(evalCase: EvalCase): {
	system: string;
	prompt: string;
} {
	const materials =
		evalCase.providedMaterials.length === 0
			? "なし"
			: evalCase.providedMaterials
					.map((m) => `- ${m.name}（${m.kind}）`)
					.join("\n");
	return {
		system: ENUM_SYSTEM,
		prompt: [
			"## 依頼",
			evalCase.request,
			"",
			"## 利用者が渡した資料",
			materials,
		].join("\n"),
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse one enumeration output strictly. Only the exact shape
 * `{"items": [non-empty strings, 1..MAX_ENUM_ITEMS]}` is accepted; the bench
 * assigns ids `w1..wN` by position. Anything else returns null — the caller
 * records an invalid enumeration output.
 */
export function parseEnumOutput(text: string): EnumConclusion | null {
	const parsed = parseJsonStrict(text);
	if (!parsed.ok || !isRecord(parsed.value)) return null;
	const value = parsed.value;
	const keys = Object.keys(value);
	if (keys.length !== 1 || !Array.isArray(value.items)) return null;
	const raw = value.items;
	if (
		raw.length === 0 ||
		raw.length > MAX_ENUM_ITEMS ||
		!raw.every((t) => typeof t === "string" && t.trim().length > 0)
	)
		return null;
	return {
		items: (raw as string[]).map((t, i) => ({ id: `w${i + 1}`, text: t })),
	};
}

/**
 * The stage-B section the composing prompt carries when an enumeration exists:
 * the item list plus the marker convention. The convention is the whole
 * contract of the auxiliary channel — markers at the head of `task`, every item
 * covered by some step, never discharged into the output's prose instead.
 */
export function enumNoteText(conclusion: EnumConclusion): string {
	const lines = [
		"## 作業項目と手順への割り当て",
		"別の担当が、この依頼に含まれる作業を先に列挙しました:",
		...conclusion.items.map((item) => `- [${item.id}] ${item.text}`),
		"",
		"手順を作るときの規約:",
		"- 各手順の task の冒頭に、その手順が担当する項目の印を [w1] の形で置いてください。1つの手順が複数の項目を担当する場合は、[w1][w2] のように続けて置きます。",
		"- 挙げられた項目はすべて、いずれかの手順が担当してください。項目の作業を、手順にせず、output の届け方の説明の中だけで済ませないでください。",
		"- 印は task の冒頭にだけ置いてください（result や deliver には書かないでください）。",
	];
	return lines.join("\n");
}

/** Markers a step cites: `[w12]` tokens in its `task` text. */
const MARKER_PATTERN = /\[w(\d+)\]/g;

const stepsOf = (definition: unknown): Record<string, unknown>[] => {
	if (!isRecord(definition) || !Array.isArray(definition.steps)) return [];
	return definition.steps.filter(isRecord);
};

/** The item ids a parsed definition's steps cite in their `task` markers. */
export function citedItemIds(definition: unknown): Set<string> {
	const cited = new Set<string>();
	for (const step of stepsOf(definition)) {
		if (typeof step.task !== "string") continue;
		for (const match of step.task.matchAll(MARKER_PATTERN))
			cited.add(`w${match[1]}`);
	}
	return cited;
}

/** The coverage of one ready definition against the enumerated items. */
export type CoverageResult = {
	/** The enumerated item count. */
	total: number;
	/** Enumerated ids at least one step cites, in enumeration order. */
	coveredIds: string[];
	/** Enumerated items no step cites, in enumeration order. */
	uncovered: WorkItem[];
};

/**
 * The deterministic set difference of stage C: enumerated ids minus cited ids.
 * Markers naming ids outside the enumeration are ignored here (and stripped
 * like any marker before scoring).
 */
export function computeCoverage(
	items: readonly WorkItem[],
	definition: unknown,
): CoverageResult {
	const cited = citedItemIds(definition);
	return {
		total: items.length,
		coveredIds: items.filter((i) => cited.has(i.id)).map((i) => i.id),
		uncovered: items.filter((i) => !cited.has(i.id)),
	};
}

/**
 * A copy of the definition with every `[wN]` marker removed from the steps'
 * `task` texts (whitespace tidied). This is the form authoring, checking, mock
 * execution and scoring see: the markers are the bench's channel, not part of
 * the authored definition. The input is never mutated.
 */
export function stripItemMarkers(definition: unknown): unknown {
	const cloned = structuredClone(definition);
	for (const step of stepsOf(cloned)) {
		if (typeof step.task !== "string") continue;
		step.task = step.task
			.replace(MARKER_PATTERN, "")
			.replace(/\s+/g, " ")
			.trim();
	}
	return cloned;
}

/** One coverage error line, in the repair prompt's machine-error format. */
export const coverageErrorLine = (item: WorkItem): string =>
	`[coverage] ${item.id}: ${item.text}`;
