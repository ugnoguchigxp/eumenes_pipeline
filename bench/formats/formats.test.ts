import { describe, expect, test } from "bun:test";
import { parseFreeMd } from "./free-md.ts";
import { parseJsonFormat } from "./json.ts";
import { parseMdYaml } from "./md-yaml.ts";
import type { ParseResult } from "./outcome.ts";

/**
 * The §5 representative example in all three formats: a command entry, an instant entry with
 * typed arguments, and a multi-material hand-on (the research result feeds the image step).
 * Every format must extract the SAME unverified definition.
 */
const DEFINITION = {
	request: "江戸時代の町並みを調べて、明日の鎌倉の天気も添えてください",
	steps: [
		{
			id: "step-1",
			bundle: "web.search",
			task: "江戸時代の町並みの特徴を出典付きで調べる",
			from: ["request"],
			result: "町並みの調査結果",
		},
		{
			id: "step-2",
			bundle: "weather.forecast",
			task: "明日の鎌倉の天気を調べる",
			from: ["request"],
			arguments: { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" },
			result: "明日の鎌倉の天気",
		},
		{
			id: "step-3",
			bundle: "image.create",
			task: "調査結果を反映した町並みの画像を作る",
			from: ["request", "step-1"],
			result: "町並みの画像1点",
		},
	],
	output: {
		from: ["step-1", "step-2", "step-3"],
		deliver: "調査結果と天気を添えて画像を提示する",
	},
};

const JSON_TEXT = JSON.stringify(DEFINITION, null, 2);

const YAML_TEXT = `説明文が前後にあってもよい。

\`\`\`yaml
request: 江戸時代の町並みを調べて、明日の鎌倉の天気も添えてください
steps:
  - id: step-1
    bundle: web.search
    task: 江戸時代の町並みの特徴を出典付きで調べる
    from: [request]
    result: 町並みの調査結果
  - id: step-2
    bundle: weather.forecast
    task: 明日の鎌倉の天気を調べる
    from: [request]
    arguments:
      place: 鎌倉
      prefecture: 神奈川県
      day: tomorrow
    result: 明日の鎌倉の天気
  - id: step-3
    bundle: image.create
    task: 調査結果を反映した町並みの画像を作る
    from: [request, step-1]
    result: 町並みの画像1点
output:
  from: [step-1, step-2, step-3]
  deliver: 調査結果と天気を添えて画像を提示する
\`\`\`
`;

const FREE_MD_TEXT = `# 依頼
江戸時代の町並みを調べて、明日の鎌倉の天気も添えてください

## 手順
1. 調査 \`web.search\`: 江戸時代の町並みの特徴を出典付きで調べる（入力: 依頼）（結果: 町並みの調査結果）
2. 天気 \`weather.forecast\`: 明日の鎌倉の天気を調べる（入力: 依頼）（引数: place=鎌倉、prefecture=神奈川県、day=tomorrow）（結果: 明日の鎌倉の天気）
3. 画像 \`image.create\`: 調査結果を反映した町並みの画像を作る（入力: 依頼、調査）（結果: 町並みの画像1点）

## 成果物
（入力: 調査、天気、画像）
調査結果と天気を添えて画像を提示する
`;

const readyDefinition = (result: ParseResult): unknown => {
	expect(result.ok).toBe(true);
	if (!result.ok || result.outcome.kind !== "ready") return null;
	return result.outcome.definition;
};

describe("the §5 representative example, in every format", () => {
	test("json, md-yaml and free-md extract the identical definition", () => {
		const fromJson = readyDefinition(parseJsonFormat(JSON_TEXT));
		const fromYaml = readyDefinition(parseMdYaml(YAML_TEXT));
		const fromFreeMd = readyDefinition(parseFreeMd(FREE_MD_TEXT));
		expect(fromJson).toEqual(DEFINITION);
		expect(fromYaml).toEqual(DEFINITION);
		expect(fromFreeMd).toEqual(DEFINITION);
	});
});
