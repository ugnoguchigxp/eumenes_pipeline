/**
 * Rendering component cards for the composing side (plan §4): the ONLY catalog information a
 * composing prompt may carry. Renderers take `ComponentCard[]` in catalog order (the order of
 * `CatalogView.offered`) and preserve it exactly, so the same catalog renders byte-identical
 * text every time.
 *
 * What is shown is what a card itself states: entry id, bundle, title, summary, use/avoid
 * conditions, the typed-arguments schema, the declared output (its schema reference), effects
 * and whether the entry may ask the user. What is never shown: support/readiness, contract
 * origins, evidence, reasons — scoring facts that would leak the bench's judgement (and gold
 * lives in cases, which never reach this module at all).
 */
import type { ComponentCard } from "../../src/contracts/component.ts";
import { canonicalJson } from "../catalog/load.ts";

/** JSON rendering: one object per card, facts only, keys canonicalized by `canonicalJson`. */
export function renderCardsJson(cards: readonly ComponentCard[]): string {
	return canonicalJson(
		cards.map((card) => ({
			entry: card.entry,
			bundle: card.bundle,
			title: card.title,
			summary: card.summary,
			useWhen: card.useWhen,
			avoidWhen: card.avoidWhen,
			...(card.arguments ? { arguments: card.arguments } : {}),
			output: card.output.schemaRef,
			effects: card.effects,
			mayAskUser: card.mayAskUser,
		})),
	);
}

type ArgumentSummary = {
	name: string;
	type: string;
	required: boolean;
	description?: string;
};

function typeName(prop: Record<string, unknown>): string {
	if (Array.isArray(prop.enum))
		return `enum(${prop.enum.map(String).join("|")})`;
	if (typeof prop.type === "string") return prop.type;
	if (Array.isArray(prop.type)) return prop.type.map(String).join("|");
	if (prop.properties && typeof prop.properties === "object") return "object";
	return "値";
}

/** Summarize an arguments JSON Schema as its properties: name, type, required, description. */
export function summarizeArguments(
	schema: Record<string, unknown>,
): ArgumentSummary[] {
	const properties =
		schema.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, unknown>)
			: {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.map(String) : [],
	);
	return Object.entries(properties).map(([name, raw]) => {
		const prop =
			raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		return {
			name,
			type: typeName(prop),
			required: required.has(name),
			...(typeof prop.description === "string"
				? { description: prop.description }
				: {}),
		};
	});
}

function effectsText(effects: ComponentCard["effects"]): string {
	if (effects.length === 0) return "なし";
	if (effects.includes("write"))
		return effects.includes("read") ? "読み取りと書き込み" : "書き込み";
	return "読み取りのみ";
}

/** Concise text rendering: one block per card, blocks separated by a blank line. */
export function renderCardsText(cards: readonly ComponentCard[]): string {
	return cards
		.map((card) => {
			const lines = [
				`- \`${card.entry}\` ${card.title}（bundle: ${card.bundle ?? "なし"}）`,
				`  目的: ${card.summary}`,
				`  使う場面: ${card.useWhen.length > 0 ? card.useWhen.join("／") : "なし"}`,
				`  使わない場面: ${card.avoidWhen.length > 0 ? card.avoidWhen.join("／") : "なし"}`,
			];
			if (card.arguments) {
				lines.push("  引数:");
				for (const arg of summarizeArguments(card.arguments))
					lines.push(
						`    - ${arg.name}: ${arg.type}（${arg.required ? "必須" : "任意"}）${arg.description ? ` — ${arg.description}` : ""}`,
					);
			} else lines.push("  引数: なし");
			lines.push(
				`  出力: ${card.output.schemaRef ?? "要約と参照のみ"}`,
				`  副作用: ${effectsText(card.effects)}`,
				`  利用者への確認: ${card.mayAskUser ? "することがある" : "しない"}`,
			);
			return lines.join("\n");
		})
		.join("\n\n");
}
