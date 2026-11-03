import { describe, expect, test } from "bun:test";
import { parseMdYaml } from "./md-yaml.ts";

const wrap = (yaml: string, before = "", after = "") =>
	`${before}\n\`\`\`yaml\n${yaml}\n\`\`\`\n${after}`;

describe("parseMdYaml", () => {
	test("extracts the single yaml fence out of surrounding prose", () => {
		const result = parseMdYaml(
			wrap(
				"request: 明日の天気を調べて\nsteps: []\n",
				"下書きです。",
				"以上です。",
			),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.outcome.kind).toBe("ready");
			if (result.outcome.kind === "ready")
				expect(result.outcome.definition).toEqual({
					request: "明日の天気を調べて",
					steps: [],
				});
		}
	});

	test("dates and times stay strings; numbers, booleans and null keep their types", () => {
		const result = parseMdYaml(
			wrap(
				"status: needs_input\nquestions:\n  - いつですか（2026-11-03）\nnote: 12:30まで\n",
			),
		);
		expect(result).toEqual({
			ok: true,
			outcome: {
				kind: "needs_input",
				questions: ["いつですか（2026-11-03）"],
				note: "12:30まで",
			},
		});
		const types = parseMdYaml(
			wrap("a: 1\nb: 1.5\nc: true\nd: null\ne: text\n"),
		);
		expect(types.ok).toBe(true);
		if (types.ok && types.outcome.kind === "ready")
			expect(types.outcome.definition).toEqual({
				a: 1,
				b: 1.5,
				c: true,
				d: null,
				e: "text",
			});
	});

	test.each([
		["本文だけ", "no_yaml_fence"],
		["```json\n{}\n```", "no_yaml_fence"],
		["```yaml\na: 1\n```\n```yaml\nb: 2\n```", "multiple_yaml_fences"],
		["```yaml\na: 1\n", "unclosed_fence"],
		["```yaml\na: &x 1\nb: 2\n```", "anchor"],
		["```yaml\nb: *x\na: &x 1\n```", "alias"],
		["```yaml\nbase: &b\n  x: 1\nderived:\n  <<: *b\n```", "anchor"],
		["```yaml\na: !!str 5\n```", "tag"],
		["```yaml\na: !custom 5\n```", "tag"],
		["```yaml\na: 1\na: 2\n```", "duplicate_key"],
		["```yaml\na: 1\n---\nb: 2\n```", "invalid_yaml"],
		["```yaml\n1: x\n```", "non_string_key"],
		["```yaml\na: .inf\n```", "non_finite"],
		["```yaml\na: [1,\n```", "invalid_yaml"],
	])("rejects %s with %s", (text, code) => {
		const result = parseMdYaml(text);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.map((e) => e.code)).toContain(code);
	});

	test("a merge key without an alias is still a merge key", () => {
		const result = parseMdYaml("```yaml\nderived:\n  <<: base\n```");
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.errors.map((e) => e.code)).toContain("merge_key");
	});
});
