/**
 * bench:catalog — P0a inventory from the snapshot (plan §10 "P0で残す成果物").
 *
 * Writes, deterministically (no timestamps, so a rerun on the same inputs changes nothing):
 * - data/catalog/inventory.json  every toolchain: card, support, reasons, evidence
 * - data/catalog/inventory.md    the same as a review table
 * - data/catalog/cards.json      the cards offered to the composing AI under the policy
 *
 *   bun run bench:catalog [--policy ready|ready+partial]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { summarize } from "../catalog/inventory.ts";
import { loadBenchCatalog, type OfferPolicy } from "../catalog/load.ts";

const { values } = parseArgs({
	options: {
		policy: { type: "string", default: "ready+partial" },
		out: { type: "string", default: "data/catalog" },
	},
});
if (values.policy !== "ready" && values.policy !== "ready+partial")
	throw new Error(`--policy must be ready or ready+partial`);
const catalog = loadBenchCatalog({ policy: values.policy as OfferPolicy });
const { records, contracts, snapshot, view } = catalog;
const summary = summarize(records);
const inputs = {
	snapshot: {
		path: "data/source/eumenes-catalog-2026-11-03.sqlite3",
		sha256: snapshot.sha256,
	},
	contracts: {
		sha256: contracts.contractsSha256,
		fixturesSha256: contracts.fixturesSha256,
		fixturesReviewed: contracts.fixturesReviewed,
		source: contracts.source,
	},
	policy: catalog.policy,
	catalogVersion: view.version,
};

mkdirSync(values.out, { recursive: true });
const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
writeFileSync(
	`${values.out}/inventory.json`,
	json({ formatVersion: 1, inputs, summary, records }),
);
writeFileSync(
	`${values.out}/cards.json`,
	json({
		formatVersion: 1,
		catalogVersion: view.version,
		policy: catalog.policy,
		cards: catalog.cards,
	}),
);

const cell = (text: string) =>
	text.replaceAll("|", "\\|").replaceAll("\n", " ");
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const lines = [
	"# P0a 部品棚卸し（自動生成）",
	"",
	"`bun run bench:catalog` が生成する。手で編集しない。判断の根拠は契約上の事実（実行種別・binding・adapter・schema参照）のみで、題名や説明文からは判断していない。",
	"",
	`- スナップショット: \`${inputs.snapshot.path}\` (sha256 \`${snapshot.sha256.slice(0, 16)}…\`)`,
	`- 契約: Eumenes \`${String(contracts.source.gitCommit ?? "?").slice(0, 12)}\` (api dirty: ${String(contracts.source.apiDirty)}), fixture reviewed: ${contracts.fixturesReviewed}`,
	`- 提示方針: \`${catalog.policy}\`、catalogVersion \`${view.version.slice(0, 16)}…\``,
	`- 件数: 全${summary.total}件、有効${summary.enabled}件 → ready ${summary.ready.length}・partial ${summary.partial.length}・excluded ${summary.excluded.length}`,
	`- 有効件数に対する対応率: ready ${pct(summary.coverage.ready)}、partial込み ${pct(summary.coverage.withFixtures)}`,
	"",
	"| entry | bundle | 実行種別 | 対応 | 入力の出所 | 出力 | effects | 理由 |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	...records.map((r) =>
		[
			"",
			`\`${r.card.entry}\``,
			r.card.bundle ? `\`${r.card.bundle}\`` : "—",
			r.execution,
			r.support,
			r.evidence.inputOrigin,
			r.card.output.schemaRef
				? `\`${r.card.output.schemaRef}\` (${r.card.output.origin})`
				: "要約・参照のみ",
			r.card.effects.join(", ") || "不明",
			cell(r.reasons.join(" / ")),
			"",
		]
			.join(" | ")
			.trim(),
	),
	"",
];
writeFileSync(`${values.out}/inventory.md`, lines.join("\n"));
console.log(
	`inventory: ${summary.total} toolchains, ${summary.enabled} enabled; ready ${summary.ready.length}, partial ${summary.partial.length}, excluded ${summary.excluded.length}; catalogVersion ${view.version.slice(0, 12)}`,
);
catalog.close();
