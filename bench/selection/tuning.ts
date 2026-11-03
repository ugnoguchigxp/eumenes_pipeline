/**
 * P4 selection tuning (plan §10 P4): learning-equivalent parameter search over the
 * Wave B retrieval methods, tuned on the DEV split only.
 *
 * Configurations (all rank the SAME offered cards for the SAME cases; only fusion
 * parameters change):
 * - `emb` / `emb-prefix`: the Wave B baselines, recomputed through the identical
 *   vendor path so this run is directly comparable with the Wave B experiment.
 * - `rrf-k<K>` / `rrfp-k<K>`: Reciprocal Rank Fusion of the BM25 ranking with the
 *   raw (resp. prefixed) embedding ranking, for k in {10, 30, 60, 100}.
 * - `wf-<W>` / `wfp-<W>`: weighted linear fusion of per-case min-max normalized
 *   scores, W = the embedding leg's weight in {25, 50, 75} (percent); the BM25 leg
 *   takes 1 - W. Raw (resp. prefixed) embedding scores.
 *
 * The freeze rule (declared before any holdout evaluation): among the tuned
 * configurations, pick the one with the highest top-12 containment on dev; break
 * ties by the higher mean reciprocal rank of the worst required entry; break any
 * remaining tie by the simplicity order in FREEZE_SIMPLICITY. The frozen
 * configuration is then evaluated ONCE on the holdout split together with the
 * plain `emb` control, and is never re-tuned from holdout numbers.
 *
 * The query is the case's `request` — the only part of a case a retriever may
 * see. Gold (`expected.requiredBundles`) is read by the scorer alone, after
 * ranking. needs_input / unsupported cases of the split have no definable
 * retrieval gold and are excluded from the denominator, counted in the report.
 */
import { cardPassages, closestSimilarities, rankBy } from "eumenes_router";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, type EvalCase } from "../cases/cases.ts";
import {
	aggregateMethodMetrics,
	createBm25Index,
	rankFromScores,
	scoreCase,
	type CaseScore,
	type EntryRanking,
	type MethodMetrics,
} from "./experiment.ts";
import type { EmbedTransport } from "./port.ts";

export const TUNING_CONFIG_IDS = [
	"emb",
	"emb-prefix",
	"rrf-k10",
	"rrf-k30",
	"rrf-k60",
	"rrf-k100",
	"rrfp-k10",
	"rrfp-k30",
	"rrfp-k60",
	"rrfp-k100",
	"wf-25",
	"wf-50",
	"wf-75",
	"wfp-25",
	"wfp-50",
	"wfp-75",
] as const;
export type TuningConfigId = (typeof TUNING_CONFIG_IDS)[number];

export const TUNING_CONFIG_DESCRIPTIONS: Record<TuningConfigId, string> = {
	emb: "現行対照: 埋め込み類似度のみ（prefix なし）",
	"emb-prefix": "query に 'query: '、passage に 'passage: ' を付けて埋め込み",
	"rrf-k10": "RRF(k=10): emb（prefix なし）順位 + BM25 順位",
	"rrf-k30": "RRF(k=30): emb（prefix なし）順位 + BM25 順位",
	"rrf-k60":
		"RRF(k=60): emb（prefix なし）順位 + BM25 順位（Wave B の rrf と同一）",
	"rrf-k100": "RRF(k=100): emb（prefix なし）順位 + BM25 順位",
	"rrfp-k10": "RRF(k=10): emb-prefix 順位 + BM25 順位",
	"rrfp-k30": "RRF(k=30): emb-prefix 順位 + BM25 順位",
	"rrfp-k60": "RRF(k=60): emb-prefix 順位 + BM25 順位",
	"rrfp-k100": "RRF(k=100): emb-prefix 順位 + BM25 順位",
	"wf-25": "重み付き融合: 0.25 * emb 正規化スコア + 0.75 * BM25 正規化スコア",
	"wf-50": "重み付き融合: 0.50 * emb 正規化スコア + 0.50 * BM25 正規化スコア",
	"wf-75": "重み付き融合: 0.75 * emb 正規化スコア + 0.25 * BM25 正規化スコア",
	"wfp-25":
		"重み付き融合: 0.25 * emb-prefix 正規化スコア + 0.75 * BM25 正規化スコア",
	"wfp-50":
		"重み付き融合: 0.50 * emb-prefix 正規化スコア + 0.50 * BM25 正規化スコア",
	"wfp-75":
		"重み付き融合: 0.75 * emb-prefix 正規化スコア + 0.25 * BM25 正規化スコア",
};

/**
 * Simplicity order for the freeze rule's last tie-break: earlier = simpler /
 * closer to the current method (plain embedding ranking first, then the
 * prefixed variant, then RRF by growing k, then weighted fusions).
 */
export const FREEZE_SIMPLICITY: readonly TuningConfigId[] = [
	"emb",
	"emb-prefix",
	"rrf-k10",
	"rrf-k30",
	"rrf-k60",
	"rrf-k100",
	"rrfp-k10",
	"rrfp-k30",
	"rrfp-k60",
	"rrfp-k100",
	"wf-25",
	"wf-50",
	"wf-75",
	"wfp-25",
	"wfp-50",
	"wfp-75",
];

/** Reciprocal Rank Fusion with an explicit k; ties by entry id (as in Wave B). */
export function reciprocalRankFusionK(
	rankings: readonly (readonly string[])[],
	entries: readonly string[],
	k: number,
): EntryRanking {
	const fused = new Map<string, number>(entries.map((entry) => [entry, 0]));
	for (const ranking of rankings)
		ranking.forEach((entry, index) => {
			fused.set(entry, (fused.get(entry) ?? 0) + 1 / (k + index + 1));
		});
	return rankFromScores(entries, fused);
}

/**
 * Per-case min-max normalization of a score map over the offered entries.
 * A degenerate map (max == min) normalizes to all zeros: it then contributes a
 * constant to any weighted sum and cannot change the fused ranking.
 */
export function normalizeScores(
	entries: readonly string[],
	scores: ReadonlyMap<string, number>,
): Map<string, number> {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const entry of entries) {
		const value = scores.get(entry) ?? 0;
		if (value < min) min = value;
		if (value > max) max = value;
	}
	const out = new Map<string, number>();
	const span = max - min;
	for (const entry of entries) {
		const value = scores.get(entry) ?? 0;
		out.set(entry, span > 0 ? (value - min) / span : 0);
	}
	return out;
}

/** Weighted linear fusion of two score maps after min-max normalization. */
export function weightedFusion(
	entries: readonly string[],
	embScores: ReadonlyMap<string, number>,
	bm25Scores: ReadonlyMap<string, number>,
	embWeight: number,
): EntryRanking {
	const embNorm = normalizeScores(entries, embScores);
	const bm25Norm = normalizeScores(entries, bm25Scores);
	const fused = new Map<string, number>(
		entries.map((entry) => [
			entry,
			embWeight * (embNorm.get(entry) ?? 0) +
				(1 - embWeight) * (bm25Norm.get(entry) ?? 0),
		]),
	);
	return rankFromScores(entries, fused);
}

/** Derives one configuration's ranking from the three base legs. */
export function deriveRanking(
	configId: TuningConfigId,
	legs: {
		entries: readonly string[];
		embRanking: EntryRanking;
		embPrefixRanking: EntryRanking;
		bm25Ranking: EntryRanking;
		embScores: ReadonlyMap<string, number>;
		embPrefixScores: ReadonlyMap<string, number>;
		bm25Scores: ReadonlyMap<string, number>;
	},
): EntryRanking {
	switch (configId) {
		case "emb":
			return legs.embRanking;
		case "emb-prefix":
			return legs.embPrefixRanking;
		case "rrf-k10":
			return reciprocalRankFusionK(
				[legs.embRanking, legs.bm25Ranking],
				legs.entries,
				10,
			);
		case "rrf-k30":
			return reciprocalRankFusionK(
				[legs.embRanking, legs.bm25Ranking],
				legs.entries,
				30,
			);
		case "rrf-k60":
			return reciprocalRankFusionK(
				[legs.embRanking, legs.bm25Ranking],
				legs.entries,
				60,
			);
		case "rrf-k100":
			return reciprocalRankFusionK(
				[legs.embRanking, legs.bm25Ranking],
				legs.entries,
				100,
			);
		case "rrfp-k10":
			return reciprocalRankFusionK(
				[legs.embPrefixRanking, legs.bm25Ranking],
				legs.entries,
				10,
			);
		case "rrfp-k30":
			return reciprocalRankFusionK(
				[legs.embPrefixRanking, legs.bm25Ranking],
				legs.entries,
				30,
			);
		case "rrfp-k60":
			return reciprocalRankFusionK(
				[legs.embPrefixRanking, legs.bm25Ranking],
				legs.entries,
				60,
			);
		case "rrfp-k100":
			return reciprocalRankFusionK(
				[legs.embPrefixRanking, legs.bm25Ranking],
				legs.entries,
				100,
			);
		case "wf-25":
			return weightedFusion(
				legs.entries,
				legs.embScores,
				legs.bm25Scores,
				0.25,
			);
		case "wf-50":
			return weightedFusion(legs.entries, legs.embScores, legs.bm25Scores, 0.5);
		case "wf-75":
			return weightedFusion(
				legs.entries,
				legs.embScores,
				legs.bm25Scores,
				0.75,
			);
		case "wfp-25":
			return weightedFusion(
				legs.entries,
				legs.embPrefixScores,
				legs.bm25Scores,
				0.25,
			);
		case "wfp-50":
			return weightedFusion(
				legs.entries,
				legs.embPrefixScores,
				legs.bm25Scores,
				0.5,
			);
		case "wfp-75":
			return weightedFusion(
				legs.entries,
				legs.embPrefixScores,
				legs.bm25Scores,
				0.75,
			);
	}
}

/**
 * Applies the declared freeze rule to dev metrics: highest top-12 containment,
 * then highest mean worst-required reciprocal rank, then FREEZE_SIMPLICITY.
 * Returns null when no configuration was evaluated.
 */
export function freezeByRule(
	metrics: Partial<Record<TuningConfigId, MethodMetrics>>,
): TuningConfigId | null {
	let best: TuningConfigId | null = null;
	for (const configId of FREEZE_SIMPLICITY) {
		const candidate = metrics[configId];
		if (!candidate) continue;
		if (!best) {
			best = configId;
			continue;
		}
		const current = metrics[best];
		if (!current) {
			best = configId;
			continue;
		}
		const candidateTop12 = candidate.containment["12"]?.cases ?? 0;
		const currentTop12 = current.containment["12"]?.cases ?? 0;
		if (candidateTop12 !== currentTop12) {
			if (candidateTop12 > currentTop12) best = configId;
			continue;
		}
		if (candidate.meanWorstReciprocal > current.meanWorstReciprocal)
			best = configId;
		// A full tie keeps the earlier (simpler) configuration.
	}
	return best;
}

export type TuningCaseResult = {
	caseId: string;
	required: string[];
	/** Per configuration: the worst required entry's rank. */
	worstRank: Partial<Record<TuningConfigId, number>>;
	/** Per configuration: each required entry's rank. */
	ranks: Partial<Record<TuningConfigId, Record<string, number>>>;
	/** The full ranking per configuration. */
	rankings: Partial<Record<TuningConfigId, EntryRanking>>;
};

export type SelectionTuningReport = {
	runId: string;
	startedAt: string;
	split: "dev" | "holdout";
	configs: TuningConfigId[];
	cases: {
		total: number;
		split: number;
		evaluated: number;
		excluded: { kind: string; count: number; reason: string }[];
	};
	cards: number;
	catalog: {
		version: string;
		snapshotSha256: string;
		contractsSha256: string;
		fixturesSha256: string;
	};
	embedding: {
		network: string;
		space: {
			modelId: string;
			revision: string;
			artifactDigest: string;
			dimension: number;
		};
	};
	methods: Partial<
		Record<TuningConfigId, { description: string; metrics: MethodMetrics }>
	>;
	/** The freeze rule applied to THIS report's metrics (dev reports only). */
	frozenByRule: TuningConfigId | null;
	perCase: TuningCaseResult[];
};

const E5_QUERY_PREFIX = "query: ";
const E5_PASSAGE_PREFIX = "passage: ";

function passagesOf(card: ComponentCard): string[] {
	return cardPassages({
		title: card.title,
		summary: card.summary,
		useWhen: card.useWhen,
		examples: [],
	});
}

/** Per-entry best-passage cosine similarities (the vendor Router's score map). */
function embeddingScores(
	perCard: readonly { entry: string; passages: readonly string[] }[],
	passageVectors: readonly number[][],
	queryVector: readonly number[],
	entries: readonly string[],
): Map<string, number> {
	const rows: Array<{ id: string; values: ArrayLike<number> }> = [];
	let offset = 0;
	for (const card of perCard) {
		for (const _passage of card.passages) {
			const values = passageVectors[offset];
			if (values) rows.push({ id: card.entry, values });
			offset += 1;
		}
	}
	return closestSimilarities(rows, queryVector, new Set(entries));
}

export async function runSelectionTuning(options: {
	transport: EmbedTransport;
	split: "dev" | "holdout";
	configIds?: readonly TuningConfigId[];
	casesDir?: string;
}): Promise<SelectionTuningReport> {
	const startedAt = new Date().toISOString();
	const runId = crypto.randomUUID();
	const configIds: TuningConfigId[] =
		options.configIds && options.configIds.length > 0
			? [...options.configIds]
			: [...TUNING_CONFIG_IDS];
	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	try {
		const cards = catalog.cards;
		const entries = cards.map((c) => c.entry);
		const perCard = cards.map((card) => ({
			entry: card.entry,
			passages: passagesOf(card),
		}));
		const flatPassages = perCard.flatMap((c) => c.passages);

		const allCases = loadCases(options.casesDir);
		const splitCases = allCases.filter((c) => c.split === options.split);
		const evaluated: EvalCase[] = [];
		const excludedByKind = new Map<string, number>();
		for (const evalCase of splitCases) {
			if (
				evalCase.expected.kind === "pipeline" &&
				(evalCase.expected.requiredBundles ?? []).length > 0
			)
				evaluated.push(evalCase);
			else
				excludedByKind.set(
					evalCase.expected.kind,
					(excludedByKind.get(evalCase.expected.kind) ?? 0) + 1,
				);
		}

		// Same four batch calls (and batch composition) as the Wave B experiment,
		// so the recomputed baselines stay comparable with its recorded numbers.
		let space: SelectionTuningReport["embedding"]["space"] | null = null;
		const embedChecked = async (texts: readonly string[]) => {
			const result = await options.transport.embed(texts);
			if (result.vectors.length !== texts.length)
				throw new Error(
					`embed transport returned ${result.vectors.length} vectors for ${texts.length} texts`,
				);
			for (const vector of result.vectors)
				if (
					vector.length !== result.space.dimension ||
					!vector.every((v) => Number.isFinite(v))
				)
					throw new Error(
						`embed transport returned a vector outside the declared space (dimension ${result.space.dimension})`,
					);
			if (!space) space = result.space;
			else if (
				space.artifactDigest !== result.space.artifactDigest ||
				space.modelId !== result.space.modelId
			)
				throw new Error(
					"embed transport changed vector space between calls; refusing to mix spaces",
				);
			return result.vectors;
		};
		const rawPassageVectors = await embedChecked(flatPassages);
		const prefixedPassageVectors = await embedChecked(
			flatPassages.map((passage) => E5_PASSAGE_PREFIX + passage),
		);
		const rawQueryVectors = await embedChecked(evaluated.map((c) => c.request));
		const prefixedQueryVectors = await embedChecked(
			evaluated.map((c) => E5_QUERY_PREFIX + c.request),
		);
		if (!space) throw new Error("embed transport produced no space");

		const bm25 = createBm25Index(perCard);

		const scoresByConfig = new Map<TuningConfigId, CaseScore[]>();
		const perCase: TuningCaseResult[] = [];
		for (const [index, evalCase] of evaluated.entries()) {
			const rawQuery = rawQueryVectors[index];
			const prefixedQuery = prefixedQueryVectors[index];
			if (!rawQuery || !prefixedQuery)
				throw new Error(
					`embed transport returned no query vector for ${evalCase.id}`,
				);
			const embScores = embeddingScores(
				perCard,
				rawPassageVectors,
				rawQuery,
				entries,
			);
			const embPrefixScores = embeddingScores(
				perCard,
				prefixedPassageVectors,
				prefixedQuery,
				entries,
			);
			const bm25Scores = bm25.score(evalCase.request);
			const legs = {
				entries,
				embRanking: rankBy(
					cards.map((c) => ({ id: c.entry })),
					embScores,
				).map((entry) => entry.id),
				embPrefixRanking: rankBy(
					cards.map((c) => ({ id: c.entry })),
					embPrefixScores,
				).map((entry) => entry.id),
				bm25Ranking: rankFromScores(entries, bm25Scores),
				embScores,
				embPrefixScores,
				bm25Scores,
			};
			const required = evalCase.expected.requiredBundles ?? [];
			const ranks: TuningCaseResult["ranks"] = {};
			const worstRank: TuningCaseResult["worstRank"] = {};
			const rankings: TuningCaseResult["rankings"] = {};
			for (const configId of configIds) {
				const ranking = deriveRanking(configId, legs);
				rankings[configId] = ranking;
				const score = scoreCase(required, ranking);
				ranks[configId] = score.ranks;
				worstRank[configId] = score.worstRank;
				const list = scoresByConfig.get(configId) ?? [];
				list.push(score);
				scoresByConfig.set(configId, list);
			}
			perCase.push({
				caseId: evalCase.id,
				required: [...required],
				ranks,
				worstRank,
				rankings,
			});
		}

		const methods: SelectionTuningReport["methods"] = {};
		const metricsOnly: Partial<Record<TuningConfigId, MethodMetrics>> = {};
		for (const configId of configIds) {
			const list = scoresByConfig.get(configId);
			if (!list) continue;
			const metrics = aggregateMethodMetrics(list);
			methods[configId] = {
				description: TUNING_CONFIG_DESCRIPTIONS[configId],
				metrics,
			};
			metricsOnly[configId] = metrics;
		}

		return {
			runId,
			startedAt,
			split: options.split,
			configs: configIds,
			cases: {
				total: allCases.length,
				split: splitCases.length,
				evaluated: evaluated.length,
				excluded: [...excludedByKind.entries()].map(([kind, count]) => ({
					kind,
					count,
					reason:
						kind === "pipeline"
							? "pipeline case without required bundles: no retrieval gold"
							: `${kind} cases have no definable retrieval gold (no required entry set)`,
				})),
			},
			cards: cards.length,
			catalog: {
				version: catalog.view.version,
				snapshotSha256: catalog.snapshot.sha256,
				contractsSha256: catalog.contracts.contractsSha256,
				fixturesSha256: catalog.contracts.fixturesSha256,
			},
			embedding: { network: options.transport.network, space },
			methods,
			frozenByRule: options.split === "dev" ? freezeByRule(metricsOnly) : null,
			perCase,
		};
	} finally {
		catalog.close();
	}
}

/** A short Japanese summary of a tuning report (the run's summary.md). */
export function renderTuningSummary(report: SelectionTuningReport): string {
	const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
	const lines: string[] = [
		`# 部品選択チューニング（P4） ${report.runId}`,
		"",
		`- 開始: ${report.startedAt}`,
		`- split: ${report.split}（pipeline ケース ${report.cases.evaluated} 件を評価。split 全体 ${report.cases.split} 件中、${report.cases.excluded.map((e) => `${e.kind} ${e.count} 件`).join("・") || "除外なし"}は検索の正解が定義できないため分母から除外）`,
		`- 提示カード: ${report.cards} 件（ready+partial）`,
		`- 埋め込み: network=${report.embedding.network}, model=${report.embedding.space.modelId}, revision=${report.embedding.space.revision}, hash=${report.embedding.space.artifactDigest.slice(0, 12)}…, ${report.embedding.space.dimension} 次元`,
		`- 評価した構成: ${report.configs.join(", ")}`,
		"",
		"## 構成ごとの指標",
		"",
		"| 構成 | top-3 | top-5 | top-8 | top-12 | 最下位 required の平均逆順位 |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const configId of report.configs) {
		const method = report.methods[configId];
		if (!method) continue;
		const c = method.metrics.containment;
		lines.push(
			`| ${configId} | ${pct(c["3"]?.rate ?? 0)} | ${pct(c["5"]?.rate ?? 0)} | ${pct(c["8"]?.rate ?? 0)} | ${pct(c["12"]?.rate ?? 0)} | ${method.metrics.meanWorstReciprocal.toFixed(3)} |`,
		);
	}
	lines.push(
		"",
		"top-k は「required 集合の全入口が上位 k 件に入ったケースの割合」。",
	);
	if (report.split === "dev")
		lines.push(
			"",
			`凍結規則（top-12 最大 → 平均逆順位 → 単純な構成優先）の適用結果: **${report.frozenByRule ?? "なし"}**`,
		);
	lines.push(
		"",
		"注意: Router 経路の候補・スコアは、評価ケースと学習文の重なりを確認できるまで未見データでの精度とは呼ばない（plan §9）。",
	);
	return `${lines.join("\n")}\n`;
}

/** The per-case record written to the work DB (kept byte-stable via canonicalJson). */
export function tuningCaseRecordJson(caseResult: TuningCaseResult): string {
	return canonicalJson({
		caseId: caseResult.caseId,
		required: caseResult.required,
		ranks: caseResult.ranks,
		worstRank: caseResult.worstRank,
	});
}
