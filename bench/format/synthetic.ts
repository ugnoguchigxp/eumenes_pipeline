/**
 * SYNTHETIC model outputs for wiring checks only — hand-written stand-ins that prove the
 * prompt → recording → replay → parse → check → mock → score path end to end. They are not
 * measurements: no model produced them, and no result obtained with them may be reported as
 * one. They live here (never in `data/runs/`) so synthetic and measured data cannot mix.
 */
export type SyntheticOutput = {
	caseId: string;
	format: "json" | "md-yaml" | "free-md";
	/** What this fixture exercises. */
	exercises: string;
	output: string;
};

export const SYNTHETIC_OUTPUTS: SyntheticOutput[] = [
	{
		caseId: "prime-count",
		format: "json",
		exercises: "a valid ready definition that passes check, mock and scoring",
		output: JSON.stringify({
			request: "1から100までの素数の個数を計算して教えてください",
			steps: [
				{
					id: "count",
					bundle: "compute.python",
					task: "1から100までの素数の個数を計算する",
					from: ["request"],
					result: "素数の個数",
				},
			],
			output: { from: ["count"], deliver: "計算した素数の個数を伝える" },
		}),
	},
	{
		caseId: "prime-count",
		format: "md-yaml",
		exercises:
			"a parseable, checkable definition that picks the wrong bundle (scoring must fail it on bundles)",
		output: [
			"定義は次のとおりです。",
			"",
			"```yaml",
			"request: 1から100までの素数の個数を計算して教えてください",
			"steps:",
			"  - id: quote",
			"    bundle: stock.quote",
			"    task: 素数の個数を調べる",
			"    from:",
			"      - request",
			"    result: 素数の個数",
			"output:",
			"  from:",
			"    - quote",
			"  deliver: 素数の個数を伝える",
			"```",
		].join("\n"),
	},
	{
		caseId: "vague-request",
		format: "json",
		exercises: "a needs_input outcome for a case whose gold is needs_input",
		output: JSON.stringify({
			status: "needs_input",
			questions: [
				"「例の件」とは、どの仕事のことですか",
				"成果物はどのような形で必要ですか",
			],
		}),
	},
	{
		caseId: "stock-quote",
		format: "md-yaml",
		exercises:
			"a parse failure: an anchor in restricted YAML must be rejected, not resolved",
		output: [
			"```yaml",
			"request: &req トヨタ自動車の今の株価を教えてください",
			"steps: []",
			"```",
		].join("\n"),
	},
];
