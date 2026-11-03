import { describe, expect, test } from "bun:test";
import { parseJsonFormat } from "./json.ts";

const definition = {
	request: "明日の鎌倉の天気を調べて",
	steps: [
		{
			id: "weather",
			bundle: "weather.forecast",
			task: "明日の鎌倉の天気を調べる",
			from: ["request"],
			arguments: { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" },
			result: "明日の鎌倉の天気",
		},
	],
	output: { from: ["weather"], deliver: "天気を伝える" },
};

describe("parseJsonFormat", () => {
	test("a bare definition (no status) is a ready outcome, values untouched", () => {
		const result = parseJsonFormat(JSON.stringify(definition, null, 2));
		expect(result).toEqual({
			ok: true,
			outcome: { kind: "ready", definition },
		});
	});

	test('status "ready" takes the definition from the "definition" field', () => {
		const result = parseJsonFormat(
			JSON.stringify({ status: "ready", definition }),
		);
		expect(result).toEqual({
			ok: true,
			outcome: { kind: "ready", definition },
		});
	});

	test("needs_input and unsupported outcomes carry their lines", () => {
		expect(
			parseJsonFormat(
				JSON.stringify({
					status: "needs_input",
					questions: ["対象の表を添付してください"],
					note: "資料不足",
				}),
			),
		).toEqual({
			ok: true,
			outcome: {
				kind: "needs_input",
				questions: ["対象の表を添付してください"],
				note: "資料不足",
			},
		});
		expect(
			parseJsonFormat(
				JSON.stringify({
					status: "unsupported",
					reasons: ["送金の部品がない"],
				}),
			),
		).toEqual({
			ok: true,
			outcome: { kind: "unsupported", reasons: ["送金の部品がない"] },
		});
	});

	test.each([
		['{"request":"a","request":"b"}', "duplicate_key"],
		['{"status":"ready"}', "missing_definition"],
		['{"status":"later","definition":{}}', "unknown_status"],
		['{"status":"needs_input","questions":"どれですか"}', "invalid_questions"],
		["[1,2]", "not_an_object"],
		["ただの文章", "syntax"],
		["", "empty"],
		["```json\n{}\n```", "syntax"],
	])("rejects %s with %s", (text, code) => {
		const result = parseJsonFormat(text);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.map((e) => e.code)).toContain(code);
	});
});
