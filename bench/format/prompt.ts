/**
 * The composing prompt of the format comparison (plan §10 P0c/P0d): ONE fixed template for
 * every format — the shared instructions and the full offered card listing — plus the output
 * rules of the one format under test. The format rules restate each parser's convention
 * exactly (`bench/formats/`), so a format is never failed for rules it was not told, and never
 * helped by rules another format did not get.
 *
 * FAIRNESS (plan §9): the prompt is built from the case's request and provided materials and
 * from the component cards alone. `expected`, acceptable answers, case notes and the fixture
 * flag never reach this module — it does not even take them as input.
 *
 * The P0c condition (now the registry's `baseline`, see `conditions.ts`): cards are rendered
 * with `renderCardsText`, the same rendering for all three formats, so the comparison
 * measures the definition format, not the card rendering. Other conditions vary only what
 * `conditions.ts` defines — which cards are offered, the rendering (`cardStyle`), and an
 * optional worked example appended to the prompt — never the shared instructions.
 */
import type { ComponentCard } from "../../src/contracts/component.ts";
import type { EvalCase } from "../cases/cases.ts";
import { renderCardsText, renderCardsTextCompact } from "../formats/cards.ts";
import type { FormatId } from "../formats/index.ts";
import type { CardStyle } from "./conditions.ts";

export const PROMPT_TEMPLATE_VERSION = "format-prompt-v1";
export const CARDS_RENDERING = "text";

export type FormatPrompt = { system: string; prompt: string };

const SHARED_INSTRUCTIONS = `あなたは、登録済みの部品（ツールチェインの公開入口）を組み合わせて、利用者の依頼を短い手順定義にまとめる担当です。

進め方:
- 依頼を満たす作業を手順に分解し、各手順に部品カードの中の入口を1つ割り当てます。
- 依頼だけでは判断できないことがあれば、推測で手順を作らず「確認が必要」と返します。
- 提示された部品では担えない依頼であれば、「対応できない」と返します。架空の部品や入口を作らないでください。

定義の意味（記述形式によらず共通）:
- request: 利用者の依頼文そのもの。
- steps: 手順の配列（1〜8件）。各手順は id（一意な小文字の識別子）、bundle（部品カードの入口ID）、task（その入口への依頼文）、from（入力元の配列）、result（期待する結果の説明）を持ちます。
  - from には "request"（元の依頼。利用者が渡した資料もここへ含まれます）か、それより前の手順の id を書きます。
  - 入口が型付き引数（arguments）を宣言している場合だけ、arguments にリテラルの値のオブジェクトを渡せます。宣言していない入口に arguments を書いてはいけません。引数を省略した場合は、入口側が task と入力から構造化します。
- output: from（最終成果物に使う手順の id の配列）と deliver（利用者への届け方の説明）。`;

const FORMAT_INSTRUCTIONS: Record<FormatId, string> = {
	json: `出力の形式（json）:
- 答えは1つの素のJSON文書だけにしてください。前後の文章、説明、コードフェンスは付けないでください。
- 手順定義が作れる場合は、定義そのものをJSONで返します: {"request": ..., "steps": [...], "output": {...}}
- 確認が必要な場合は {"status": "needs_input", "questions": ["質問", ...]} を返します（questions は1件以上）。
- 対応できない場合は {"status": "unsupported", "reasons": ["理由", ...]} を返します（reasons は1件以上）。`,
	"md-yaml": `出力の形式（md-yaml）:
- Markdown の中に \`\`\`yaml のコードフェンスをちょうど1つだけ置き、その中に定義をYAMLで書いてください。定義はフェンスの中だけに書きます。
- YAMLはプレーンなデータだけ（マップ・配列・文字列・数値・真偽値・null）を使い、アンカー（&）・エイリアス（*）・タグ・mergeキー（<<）・重複キーは使わないでください。
- 手順定義が作れる場合は、フェンスの中に定義そのもの（request / steps / output）を書きます。
- 確認が必要な場合は status: needs_input と questions のリストを、対応できない場合は status: unsupported と reasons のリストを、同じフェンスの中に書いてください（どちらも1件以上）。`,
	"free-md": `出力の形式（free-md）:
- 次の見出し構造のMarkdownで書いてください。
  - \`# 依頼\` の下に、利用者の依頼文をそのまま書きます。
  - \`## 手順\` の下に、手順を番号付き項目で実行順に書きます。各項目では、部品の入口IDをバッククォートで示し（例: \`web.search\`）、その前にある文が手順の名前になります。入力は (入力: 依頼) や (入力: 前の手順の名前) の形で、型付き引数は (引数: key=value) の形で、期待する結果は (結果: ...) の形で書けます。残りの文が、その入口への依頼文です。
  - \`## 成果物\` の下に成果物の説明を書き、使う手順は (入力: 手順の名前) で示します（無ければ全手順が対象です）。
  - 確認が必要な場合は \`## 確認\` の下に質問を1行ずつ書き、対応できない場合は \`## 対応不可\` の下に理由を1行ずつ書きます（このとき \`## 手順\` は書きません）。`,
};

/**
 * Build the one composing prompt of a (case, format) cell under a prompt condition.
 * Deterministic in its inputs. With no condition options this is the `baseline` condition
 * and the output is byte-identical to the pre-condition bench.
 */
export function buildFormatPrompt(input: {
	evalCase: EvalCase;
	format: FormatId;
	cards: readonly ComponentCard[];
	/** Card rendering of the condition (default: the full rendering). */
	cardStyle?: CardStyle;
	/** The condition's worked example for this format, appended after the cards. */
	workedExample?: string;
}): FormatPrompt {
	const { evalCase, format, cards } = input;
	const materials =
		evalCase.providedMaterials.length === 0
			? "なし"
			: evalCase.providedMaterials
					.map((m) => `- ${m.name}（${m.kind}）`)
					.join("\n");
	const sections = [
		"## 依頼",
		evalCase.request,
		"",
		"## 利用者が渡した資料",
		materials,
		"",
		"## 部品カード",
		input.cardStyle === "compact"
			? renderCardsTextCompact(cards)
			: renderCardsText(cards),
	];
	if (input.workedExample !== undefined)
		sections.push(
			"",
			"## 作業例",
			"次は、別の依頼に対する完成形の例です。この例の依頼には答えず、形だけを参考にしてください。",
			"",
			input.workedExample,
		);
	return {
		system: `${SHARED_INSTRUCTIONS}\n\n${FORMAT_INSTRUCTIONS[format]}`,
		prompt: sections.join("\n"),
	};
}
