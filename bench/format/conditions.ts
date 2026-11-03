/**
 * Prompt conditions of the format/selection comparisons (plan §10): a condition fixes WHICH
 * cards the composing side is offered, HOW they are rendered, WHETHER the prompt carries
 * a worked example, and — for the json format only — the output style it asks for.
 * Conditions are data, recorded in every run's config and summary, so two runs are only
 * ever compared like-for-like. The prompt digest is still computed from the prompt text
 * itself: change the condition and the digest changes, so a recording prepared under one
 * condition can never be replayed under another by accident.
 *
 * The registry holds the fixed conditions. A per-case candidate subset (Router or oracle
 * output, supplied as a file) is not a registry entry: the CLI derives its condition id from
 * the file's digest (`subset:<first 8 hex>`), because the subset differs per case.
 *
 * `baseline` is the P0c/P0d condition — every offered card, the full rendering, no example —
 * and it builds byte-identical prompts to the pre-condition bench, so the recordings of
 * session `p0d-agent-model-1` stay valid under it.
 */
import type { FormatId } from "../formats/index.ts";

/** How the offered cards are rendered into the prompt. */
export type CardStyle = "full" | "compact";

/**
 * An optional guidance block appended to the shared instructions (its text lives
 * in `prompt.ts`). `threshold-v1` states the general convention for when a request
 * counts as missing information (`needs_input`) versus when unspecified detail is
 * left to the steps — the accuracy follow-up 2 condition A. Guidance is condition
 * data like everything else here: recorded in the run config via the summary.
 */
export type GuidanceId = "threshold-v1";

/**
 * The output style the instructions ask for. `minified` is defined for the json format
 * only (see `buildFormatPrompt`): it adds the minified-JSON instruction to the json
 * format's rules and leaves the other formats' prompts byte-identical to `default`.
 */
export type OutputStyle = "default" | "minified";

/** Which cards a condition offers: every offered card, or one fixed entry subset. */
export type ConditionCardSet = "all" | { entries: readonly string[] };

export type FormatCondition = {
	id: string;
	cardSet: ConditionCardSet;
	cardStyle: CardStyle;
	/** Worked examples embedded in the prompt (0 or 1; see `WORKED_EXAMPLES`). */
	shots: 0 | 1;
	/** Output style asked for (json only; the other formats ignore `minified`). */
	outputStyle: OutputStyle;
	/** Guidance block appended to the shared instructions; absent on most conditions. */
	guidance?: GuidanceId;
};

export const BASELINE_CONDITION: FormatCondition = {
	id: "baseline",
	cardSet: "all",
	cardStyle: "full",
	shots: 0,
	outputStyle: "default",
};

/** The fixed condition registry, by id. */
export const CONDITIONS: Readonly<{
	baseline: FormatCondition;
	compact: FormatCondition;
	oneshot: FormatCondition;
	minjson: FormatCondition;
	threshold: FormatCondition;
}> = {
	baseline: BASELINE_CONDITION,
	compact: {
		id: "compact",
		cardSet: "all",
		cardStyle: "compact",
		shots: 0,
		outputStyle: "default",
	},
	oneshot: {
		id: "oneshot",
		cardSet: "all",
		cardStyle: "full",
		shots: 1,
		outputStyle: "default",
	},
	minjson: {
		id: "minjson",
		cardSet: "all",
		cardStyle: "full",
		shots: 0,
		outputStyle: "minified",
	},
	threshold: {
		id: "threshold",
		cardSet: "all",
		cardStyle: "full",
		shots: 0,
		outputStyle: "default",
		guidance: "threshold-v1",
	},
};

/** Look a condition up by id; an unknown id is a bench error, never a silent default. */
export function resolveCondition(id: string): FormatCondition {
	const condition = (CONDITIONS as Record<string, FormatCondition>)[id];
	if (!condition)
		throw new Error(
			`unknown condition "${id}" (registry: ${Object.keys(CONDITIONS).join(", ")})`,
		);
	return condition;
}

/** Condition id of a per-case candidate file: `subset:` + the first 8 hex of its digest. */
export const subsetConditionId = (fileDigest: string): string =>
	`subset:${fileDigest.slice(0, 8)}`;

/** What a run records about its condition (the candidates themselves live in the prompts). */
export type ConditionSummary = {
	id: string;
	cardSet: "all" | "subset";
	cardStyle: CardStyle;
	shots: 0 | 1;
	outputStyle: OutputStyle;
	/** Present only on guidance conditions, so other summaries keep their shape. */
	guidance?: GuidanceId;
};

export function summarizeCondition(
	condition: FormatCondition,
	hasCandidates: boolean,
): ConditionSummary {
	return {
		id: condition.id,
		cardSet: hasCandidates || condition.cardSet !== "all" ? "subset" : "all",
		cardStyle: condition.cardStyle,
		shots: condition.shots,
		outputStyle: condition.outputStyle,
		...(condition.guidance ? { guidance: condition.guidance } : {}),
	};
}

/**
 * The one worked example of the `oneshot` condition: a single-step request that completes
 * with one entry alone (the weather in Fukuoka, answered by `weather.forecast` with its
 * typed arguments). The request text is deliberately identical to NO case in `data/cases/`
 * (a test pins that), and the example shows a lone step only — never the shape of a
 * multi-step case — so it teaches the format, not any case's answer.
 */
export const WORKED_EXAMPLE_REQUEST = "明日の福岡の天気を教えてください";

export const WORKED_EXAMPLES: Record<FormatId, string> = {
	json: `{
  "request": "明日の福岡の天気を教えてください",
  "steps": [
    {
      "id": "weather",
      "bundle": "weather.forecast",
      "task": "明日の福岡の天気予報を調べる",
      "from": ["request"],
      "arguments": { "place": "福岡", "prefecture": "福岡県", "day": "tomorrow" },
      "result": "明日の福岡の天気予報"
    }
  ],
  "output": { "from": ["weather"], "deliver": "天気予報を利用者に伝える" }
}`,
	"md-yaml": `\`\`\`yaml
request: 明日の福岡の天気を教えてください
steps:
  - id: weather
    bundle: weather.forecast
    task: 明日の福岡の天気予報を調べる
    from:
      - request
    arguments:
      place: 福岡
      prefecture: 福岡県
      day: tomorrow
    result: 明日の福岡の天気予報
output:
  from:
    - weather
  deliver: 天気予報を利用者に伝える
\`\`\``,
	"free-md": `# 依頼
明日の福岡の天気を教えてください

## 手順
1. 天気予報 \`weather.forecast\` (入力: 依頼) (引数: place=福岡, prefecture=福岡県, day=tomorrow) (結果: 明日の福岡の天気予報) 明日の福岡の天気予報を調べます。

## 成果物
天気予報を利用者に伝える (入力: 天気予報)`,
};
