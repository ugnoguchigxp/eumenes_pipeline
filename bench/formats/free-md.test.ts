import { describe, expect, test } from "bun:test";
import { parseFreeMd } from "./free-md.ts";

const doc = (body: string) => `# 依頼\n依頼文です\n\n${body}`;

describe("parseFreeMd", () => {
	test("reads steps, labels, inputs, arguments and the output", () => {
		const result = parseFreeMd(`# 依頼
明日の鎌倉の天気を調べて、傘が要るか計算してください

## 手順
1. 天気 \`weather.forecast\`: 明日の鎌倉の天気を調べる（入力: 依頼）（引数: place=鎌倉、prefecture=神奈川県、day=tomorrow）（結果: 明日の天気予報）
2. 計算 \`compute.python\`: 降水確率から傘が要るか計算する（入力: 天気）

## 成果物
（入力: 天気、計算）
天気予報と計算結果を伝える
`);
		expect(result).toEqual({
			ok: true,
			outcome: {
				kind: "ready",
				definition: {
					request: "明日の鎌倉の天気を調べて、傘が要るか計算してください",
					steps: [
						{
							id: "step-1",
							bundle: "weather.forecast",
							task: "明日の鎌倉の天気を調べる",
							from: ["request"],
							arguments: {
								place: "鎌倉",
								prefecture: "神奈川県",
								day: "tomorrow",
							},
							result: "明日の天気予報",
						},
						{
							id: "step-2",
							bundle: "compute.python",
							task: "降水確率から傘が要るか計算する",
							from: ["step-1"],
							result: "降水確率から傘が要るか計算する",
						},
					],
					output: {
						from: ["step-1", "step-2"],
						deliver: "天気予報と計算結果を伝える",
					},
				},
			},
		});
	});

	test("output.from defaults to every step; arguments read JSON literals", () => {
		const result = parseFreeMd(
			doc(`## 手順
1. 計算 \`compute.python\`: 数える（引数: count=3、verbose=true、label="a b"）

## 成果物
結果を伝える
`),
		);
		expect(result.ok).toBe(true);
		if (result.ok && result.outcome.kind === "ready") {
			const definition = result.outcome.definition as {
				steps: Array<Record<string, unknown>>;
				output: { from: string[] };
			};
			expect(definition.steps[0]?.arguments).toEqual({
				count: 3,
				verbose: true,
				label: "a b",
			});
			expect(definition.output.from).toEqual(["step-1"]);
		}
	});

	test("確認 and 対応不可 sections decide the state; list markers are stripped", () => {
		expect(
			parseFreeMd(
				doc(`## 確認
- 対象の表を添付してください
- 期間は今週でよいですか
`),
			),
		).toEqual({
			ok: true,
			outcome: {
				kind: "needs_input",
				questions: ["対象の表を添付してください", "期間は今週でよいですか"],
			},
		});
		expect(
			parseFreeMd(
				doc(`## 対応不可
・送金を行う部品がないため対応できません
`),
			),
		).toEqual({
			ok: true,
			outcome: {
				kind: "unsupported",
				reasons: ["送金を行う部品がないため対応できません"],
			},
		});
	});

	test.each([
		["## 手順\n1. 計算 `compute.python`: 数える\n", "missing_output"],
		["## 成果物\n結果を伝える\n", "missing_steps"],
		[
			"## 手順\n1. 計算する（入力: 依頼）\n\n## 成果物\n伝える\n",
			"item_without_entry",
		],
		[
			"## 手順\n1. 計算 `compute.python`: 数える（入力: 謎の資料）\n\n## 成果物\n伝える\n",
			"unknown_input",
		],
		[
			"## 手順\n1. 計算 `compute.python`: 数える（入力: 後続）\n2. 後続 `cli.run`: 実行する\n\n## 成果物\n伝える\n",
			"unknown_input",
		],
		["## 確認\n- どれですか\n\n## 対応不可\n・できません\n", "ambiguous_state"],
		[
			"## 手順\n1. 同じ `compute.python`: 数える\n2. 同じ `cli.run`: 実行する\n\n## 成果物\n伝える\n",
			"duplicate_label",
		],
	])("rejects a broken document with %s", (body, code) => {
		const result = parseFreeMd(doc(body));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.map((e) => e.code)).toContain(code);
	});

	test("a ready document without # 依頼 fails", () => {
		const result = parseFreeMd(
			"## 手順\n1. 計算 `compute.python`: 数える\n\n## 成果物\n伝える\n",
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.errors.map((e) => e.code)).toContain("missing_request");
	});
});
