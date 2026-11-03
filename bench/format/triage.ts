/**
 * The triage pre-pass (accuracy follow-up 2, condition B): before composing, a
 * short separate generation judges ONLY whether the request's information is
 * sufficient — whether its target can be identified from the request text and
 * the provided materials — and the conclusion is handed to the composing prompt
 * as an advisory final section. The composer still makes the final call (it may
 * author a definition, ask, or decline); the stage separates the threshold
 * judgment from the authoring work so each can be measured on its own.
 *
 * Fairness: the triage prompt is built from the case's request and provided
 * materials alone — no cards, no expected values, no case notes (the same rule
 * as the composing prompt, minus the parts a sufficiency judgment does not
 * need). The verdict document is parsed with the strict JSON reader; anything
 * that is not exactly the verdict shape is an invalid triage output, recorded
 * as such, never guessed at.
 */
import type { EvalCase } from "../cases/cases.ts";
import { parseJsonStrict } from "../formats/strict-json.ts";

/** The triage template recorded in a triage run's config. */
export const TRIAGE_TEMPLATE_VERSION = "triage-v1";

export type TriageVerdict = "proceed" | "needs_input";

export type TriageConclusion = {
	verdict: TriageVerdict;
	/** The questions that would identify the target; non-empty iff `needs_input`. */
	questions: string[];
};

const TRIAGE_SYSTEM = `あなたは、依頼を受けて手順定義を作る前段で、その依頼の情報が足りているかを判定する担当です。

進め方:
- 判定するのは「依頼の対象が、依頼文と渡された資料から特定できるか」だけです。手順の内容や部品の選択は判断しません。
- 対象が特定できれば proceed です。進め方や届け方の細部（保存先・宛先・書式など）が未指定でも proceed とします。
- 対象そのものが特定できなければ needs_input とし、対象を特定するために必要な質問だけを挙げます。
- 出力は1つの素のJSON文書だけにしてください。前後の文章や説明は付けないでください: {"verdict": "proceed"} または {"verdict": "needs_input", "questions": ["質問", ...]}（questions は1件以上）。`;

/** The one triage prompt of a case: its request and materials, nothing else. */
export function buildTriagePrompt(evalCase: EvalCase): {
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
		system: TRIAGE_SYSTEM,
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
 * Parse one triage output strictly. Only the exact verdict shape is accepted:
 * `{"verdict": "proceed"}` (no questions) or
 * `{"verdict": "needs_input", "questions": [non-empty strings, 1+]}`.
 * Anything else returns null — the caller records an invalid triage output.
 */
export function parseTriageOutput(text: string): TriageConclusion | null {
	const parsed = parseJsonStrict(text);
	if (!parsed.ok || !isRecord(parsed.value)) return null;
	const value = parsed.value;
	const keys = Object.keys(value).sort();
	if (value.verdict === "proceed") {
		if (keys.length !== 1) return null;
		return { verdict: "proceed", questions: [] };
	}
	if (value.verdict === "needs_input") {
		if (keys.length !== 2 || !Array.isArray(value.questions)) return null;
		const questions = value.questions;
		if (
			questions.length === 0 ||
			!questions.every((q) => typeof q === "string" && q.trim().length > 0)
		)
			return null;
		return { verdict: "needs_input", questions: questions as string[] };
	}
	return null;
}

/**
 * The advisory section the composing prompt carries when a triage conclusion
 * exists. It reports the pre-pass verdict (and its questions) and leaves the
 * final judgment to the composer.
 */
export function triageNoteText(conclusion: TriageConclusion): string {
	const lines = ["## 事前の情報充足判定"];
	if (conclusion.verdict === "proceed")
		lines.push(
			"別の担当がこの依頼の情報充足を先に判定しました: 依頼の対象は特定できており、手順を作成できます。",
		);
	else {
		lines.push(
			"別の担当がこの依頼の情報充足を先に判定しました: 依頼の対象を特定するには、次の情報が不足しています。",
			...conclusion.questions.map((q) => `- ${q}`),
		);
	}
	lines.push("この判定も踏まえて、最終判断はあなた自身が行ってください。");
	return lines.join("\n");
}
