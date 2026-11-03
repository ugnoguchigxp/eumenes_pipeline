import { describe, expect, test } from "bun:test";
import { loadCases } from "../cases/cases.ts";
import { buildFormatPrompt } from "./prompt.ts";
import { GUIDANCE_TEXTS, THRESHOLD_GUIDANCE } from "./prompt.ts";
import {
	buildTriagePrompt,
	parseTriageOutput,
	triageNoteText,
} from "./triage.ts";

/**
 * The triage pre-pass (accuracy follow-up 2B) and the threshold guidance
 * (follow-up 2A): the verdict document is parsed strictly, the triage prompt
 * carries the request and materials only, and the guidance text states general
 * principles — it must never name an evaluation case or an expected answer.
 */
describe("parseTriageOutput", () => {
	test("accepts exactly the two verdict shapes", () => {
		expect(parseTriageOutput('{"verdict": "proceed"}')).toEqual({
			verdict: "proceed",
			questions: [],
		});
		expect(
			parseTriageOutput(
				'{"verdict": "needs_input", "questions": ["どこの天気ですか"]}',
			),
		).toEqual({
			verdict: "needs_input",
			questions: ["どこの天気ですか"],
		});
	});

	test("refuses anything else, including near-misses", () => {
		expect(parseTriageOutput("進めてよいと思います")).toBeNull();
		expect(
			parseTriageOutput('{"verdict": "proceed", "questions": []}'),
		).toBeNull();
		expect(parseTriageOutput('{"verdict": "needs_input"}')).toBeNull();
		expect(
			parseTriageOutput('{"verdict": "needs_input", "questions": []}'),
		).toBeNull();
		expect(
			parseTriageOutput('{"verdict": "needs_input", "questions": ["  "]}'),
		).toBeNull();
		expect(parseTriageOutput('{"verdict": "maybe"}')).toBeNull();
		expect(
			parseTriageOutput('{"verdict": "proceed", "verdict": "proceed"}'),
		).toBeNull();
	});
});

describe("buildTriagePrompt / triageNoteText", () => {
	test("the prompt carries the request and the materials, and no cards section", () => {
		const evalCase = loadCases().find((c) => c.id === "prime-count");
		if (!evalCase) throw new Error("case prime-count missing");
		const { system, prompt } = buildTriagePrompt(evalCase);
		expect(prompt).toContain(evalCase.request);
		expect(prompt).not.toContain("部品カード");
		expect(system).toContain('"verdict"');
	});

	test("the note reports the verdict and, for needs_input, its questions", () => {
		const proceed = triageNoteText({ verdict: "proceed", questions: [] });
		expect(proceed).toContain("## 事前の情報充足判定");
		expect(proceed).toContain("手順を作成できます");
		const needs = triageNoteText({
			verdict: "needs_input",
			questions: ["どの会社の株価ですか"],
		});
		expect(needs).toContain("- どの会社の株価ですか");
		expect(needs).toContain("最終判断はあなた自身が行ってください");
	});
});

describe("threshold guidance (condition A)", () => {
	test("the guidance text is registered and names no case and no entry", () => {
		expect(GUIDANCE_TEXTS["threshold-v1"]).toBe(THRESHOLD_GUIDANCE);
		for (const evalCase of loadCases())
			expect(THRESHOLD_GUIDANCE).not.toContain(evalCase.id);
		// No component entry id appears either: principles only.
		expect(THRESHOLD_GUIDANCE).not.toMatch(/[a-z]+\.[a-z]+/);
	});

	test("a guidance prompt appends the block to the system; baseline stays without it", () => {
		const evalCase = loadCases().find((c) => c.id === "prime-count");
		if (!evalCase) throw new Error("case prime-count missing");
		const guided = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: [],
			guidanceText: THRESHOLD_GUIDANCE,
		});
		expect(guided.system).toContain("判断の規約");
		const plain = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: [],
		});
		expect(plain.system).not.toContain("判断の規約");
	});
});
