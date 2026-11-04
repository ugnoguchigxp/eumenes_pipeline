import { describe, expect, test } from "bun:test";
import { loadCases } from "../cases/cases.ts";
import {
	buildEnumPrompt,
	computeCoverage,
	coverageErrorLine,
	citedItemIds,
	enumNoteText,
	MAX_ENUM_ITEMS,
	parseEnumOutput,
	stripItemMarkers,
	type EnumConclusion,
} from "./enumerate.ts";
import { buildFormatPrompt } from "./prompt.ts";

/**
 * Stage A of the staged generation (the enumeration pre-pass) and stage C's
 * deterministic half: the item list is parsed strictly and ids are assigned by
 * the bench, the prompt carries the request and materials only, coverage is a
 * plain set difference over the steps' task markers, and marker stripping
 * leaves a definition the ordinary evaluator path can score unchanged.
 */
describe("parseEnumOutput", () => {
	test("accepts the item-list shape and assigns ids by position", () => {
		expect(
			parseEnumOutput('{"items": ["月光仮面について調べる", "紹介文を書く"]}'),
		).toEqual({
			items: [
				{ id: "w1", text: "月光仮面について調べる" },
				{ id: "w2", text: "紹介文を書く" },
			],
		});
	});

	test("refuses anything else, including near-misses", () => {
		expect(parseEnumOutput("調べる、書く、届ける")).toBeNull();
		expect(parseEnumOutput('{"items": []}')).toBeNull();
		expect(parseEnumOutput('{"items": ["  "]}')).toBeNull();
		expect(parseEnumOutput('{"items": ["調べる"], "steps": []}')).toBeNull();
		expect(parseEnumOutput('{"items": "調べる"}')).toBeNull();
		expect(parseEnumOutput('{"items": [42]}')).toBeNull();
		const tooMany = JSON.stringify({
			items: Array.from({ length: MAX_ENUM_ITEMS + 1 }, (_, i) => `作業${i}`),
		});
		expect(parseEnumOutput(tooMany)).toBeNull();
		// A duplicated key is a strict-parse failure, never silently resolved.
		expect(parseEnumOutput('{"items": ["a"], "items": ["b"]}')).toBeNull();
	});
});

describe("buildEnumPrompt", () => {
	test("carries the request and the materials, no cards, no entry names", () => {
		const evalCase = loadCases().find((c) => c.id === "chain-gekko-kamen");
		if (!evalCase) throw new Error("case chain-gekko-kamen missing");
		const { system, prompt } = buildEnumPrompt(evalCase);
		expect(prompt).toContain(evalCase.request);
		expect(prompt).not.toContain("部品カード");
		// The enumeration judges no sufficiency and names no component entry.
		expect(system).not.toMatch(/[a-z]+\.[a-z]+/);
		expect(system).toContain('"items"');
	});
});

describe("enumNoteText", () => {
	test("lists the items with their ids and states the marker convention", () => {
		const conclusion: EnumConclusion = {
			items: [
				{ id: "w1", text: "調べる" },
				{ id: "w2", text: "届ける" },
			],
		};
		const note = enumNoteText(conclusion);
		expect(note).toContain("- [w1] 調べる");
		expect(note).toContain("- [w2] 届ける");
		expect(note).toContain("task の冒頭");
		expect(note).toContain(
			"output の届け方の説明の中だけで済ませないでください",
		);
	});

	test("the composing prompt appends the note as its final section", () => {
		const evalCase = loadCases().find((c) => c.id === "prime-count");
		if (!evalCase) throw new Error("case prime-count missing");
		const conclusion: EnumConclusion = {
			items: [{ id: "w1", text: "素数の個数を計算する" }],
		};
		const noted = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: [],
			enumNote: enumNoteText(conclusion),
		});
		expect(noted.prompt.endsWith(enumNoteText(conclusion))).toBe(true);
		const plain = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: [],
		});
		expect(plain.prompt).not.toContain("作業項目と手順への割り当て");
	});
});

describe("coverage over task markers", () => {
	const items = [
		{ id: "w1", text: "調べる" },
		{ id: "w2", text: "書く" },
		{ id: "w3", text: "届ける" },
	];
	const definition = {
		request: "依頼",
		steps: [
			{ id: "a", task: "[w1] 調べる", from: ["request"] },
			{ id: "b", task: "[w2][w3] 書いて届ける", from: ["a"] },
			{ id: "c", task: "印のない手順", from: ["a"] },
		],
		output: { from: ["b"], deliver: "届ける" },
	};

	test("cited ids come from the steps' task markers only", () => {
		expect([...citedItemIds(definition)].sort()).toEqual(["w1", "w2", "w3"]);
		// A marker in the deliver prose is not a citation.
		expect(
			citedItemIds({ steps: [], output: { deliver: "[w1] 届ける" } }),
		).toEqual(new Set());
	});

	test("coverage is the set difference, in enumeration order", () => {
		const partial = {
			steps: [{ id: "a", task: "[w3] 届ける", from: ["request"] }],
		};
		const coverage = computeCoverage(items, partial);
		expect(coverage.total).toBe(3);
		expect(coverage.coveredIds).toEqual(["w3"]);
		expect(coverage.uncovered.map((i) => i.id)).toEqual(["w1", "w2"]);
		expect(coverageErrorLine({ id: "w1", text: "調べる" })).toBe(
			"[coverage] w1: 調べる",
		);
		// Markers outside the enumeration are ignored, not errors.
		const alien = { steps: [{ id: "a", task: "[w9] 何か", from: [] }] };
		expect(computeCoverage(items, alien).uncovered).toHaveLength(3);
	});

	test("stripping removes markers from task texts and nothing else", () => {
		const stripped = stripItemMarkers(definition) as {
			steps: { task: string }[];
			output: { deliver: string };
		};
		expect(stripped.steps.map((s) => s.task)).toEqual([
			"調べる",
			"書いて届ける",
			"印のない手順",
		]);
		expect(stripped.output.deliver).toBe("届ける");
		// The input is not mutated.
		expect(definition.steps[0]?.task).toBe("[w1] 調べる");
	});
});
