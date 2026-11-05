import { captureCases, type CaseSnapshot } from "../cases/provenance.ts";
/**
 * Wave B selection experiment (plan §9, §10): five retrieval methods rank the SAME offered
 * cards for the SAME dev-split pipeline cases, and only the ranking changes.
 *
 * - The query is the case's `request` — the only part of a case a retriever may see. Gold
 *   (`expected.requiredBundles`) is read by the scorer alone, after ranking.
 * - The searched texts are the vendor Router's `cardPassages` (title/summary/useWhen; the
 *   composing side's cards carry no examples), identical for every method.
 * - needs_input / unsupported dev cases have no definable retrieval gold, so they are
 *   excluded from the denominator and counted in the report — never silently dropped.
 * - The rerank method reorders the embedding method's top-N with the PUBLIC
 *   `cl-nagoya/ruri-reranker-small` (see rerank.ts). It is not the user's retrained
 *   production reranker, and its numbers are never mixed with the production network's.
 *
 * Metrics per method: for k in {3, 5, 8, 12}, the share of cases whose required entries
 * ALL land within the top-k; and the mean reciprocal rank of each case's worst-ranked
 * required entry. Cases where the methods disagree are listed with per-entry ranks.
 */
import { cardPassages, closestSimilarities, rankBy } from "eumenes_router";
import { byCodeUnit } from "../../src/catalog.ts";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, type EvalCase } from "../cases/cases.ts";
import type { EmbedTransport } from "./port.ts";

export const METHOD_IDS = [
	"emb",
	"emb-prefix",
	"bm25",
	"rrf",
	"emb-rerank",
] as const;
export type MethodId = (typeof METHOD_IDS)[number];

export const METHOD_DESCRIPTIONS: Record<MethodId, string> = {
	emb: "埋め込み類似度のみ（prefix なし）。vendor Router の cardPassages + closestSimilarities + rankBy と同一経路",
	"emb-prefix":
		"query に 'query: '、passage に 'passage: ' を付けて埋め込み（e5 の作法）。順位付けは emb と同一",
	bm25: "cardPassages への BM25（空白除去後の文字 2-gram + 3-gram、k1=1.2・b=0.75。カードの点数は passage の最大値、同点は入口 ID 順）",
	rrf: "emb と bm25 の順位を Reciprocal Rank Fusion (k=60) で融合（同点は入口 ID 順）",
	"emb-rerank":
		"emb の上位20件を公開版 cl-nagoya/ruri-reranker-small で並べ替え（カードの点数は passage ごとのスコアの最大値、同点は emb の順位を維持）。本番の再学習版ではない",
};

export const CONTAINMENT_KS = [3, 5, 8, 12] as const;
export const RRF_K = 60;
export const RERANK_TOP_N = 20;
const E5_QUERY_PREFIX = "query: ";
const E5_PASSAGE_PREFIX = "passage: ";

/** Full ranking of the offered entries, best first. */
export type EntryRanking = string[];

/** Orders entries by a score map: score descending, ties by entry id (code-unit order). */
export function rankFromScores(
	entries: readonly string[],
	scores: ReadonlyMap<string, number>,
): EntryRanking {
	return [...entries].sort((a, b) => {
		const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
		return diff !== 0 ? diff : byCodeUnit(a, b);
	});
}

/** Character 2-grams and 3-grams of the whitespace-stripped text (the BM25 tokens). */
export function charNgramTokens(text: string): string[] {
	const flat = text.replace(/\s+/g, "");
	const tokens: string[] = [];
	for (const n of [2, 3])
		for (let i = 0; i + n <= flat.length; i++)
			tokens.push(flat.slice(i, i + n));
	return tokens;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export type Bm25Index = {
	/** Each entry's best passage score for the query (0 when nothing matches). */
	score: (query: string) => Map<string, number>;
};

/** BM25 over the cards' passages; an entry's score is its best passage's score. */
export function createBm25Index(
	perEntry: readonly { entry: string; passages: readonly string[] }[],
): Bm25Index {
	type Doc = { entry: string; tf: Map<string, number>; length: number };
	const docs: Doc[] = [];
	const df = new Map<string, number>();
	for (const { entry, passages } of perEntry)
		for (const passage of passages) {
			const tokens = charNgramTokens(passage);
			const tf = new Map<string, number>();
			for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
			for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
			docs.push({ entry, tf, length: tokens.length });
		}
	const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0);
	const avgdl = totalLength / Math.max(1, docs.length);
	const idf = (token: string): number => {
		const d = df.get(token) ?? 0;
		return Math.log(1 + (docs.length - d + 0.5) / (d + 0.5));
	};
	return {
		score: (query) => {
			const terms = new Set(charNgramTokens(query));
			const best = new Map<string, number>();
			for (const doc of docs) {
				let score = 0;
				for (const term of terms) {
					const tf = doc.tf.get(term);
					if (!tf) continue;
					score +=
						(idf(term) * (tf * (BM25_K1 + 1))) /
						(tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl)));
				}
				if (score > (best.get(doc.entry) ?? 0)) best.set(doc.entry, score);
			}
			for (const { entry } of perEntry)
				if (!best.has(entry)) best.set(entry, 0);
			return best;
		},
	};
}

/** Reciprocal Rank Fusion (k = RRF_K) over full rankings; ties by entry id. */
export function reciprocalRankFusion(
	rankings: readonly (readonly string[])[],
	entries: readonly string[],
): EntryRanking {
	const fused = new Map<string, number>(entries.map((entry) => [entry, 0]));
	for (const ranking of rankings)
		ranking.forEach((entry, index) => {
			fused.set(entry, (fused.get(entry) ?? 0) + 1 / (RRF_K + index + 1));
		});
	return rankFromScores(entries, fused);
}

export type CaseScore = {
	/** 1-based rank of each required entry (an entry past the ranking counts as length + 1). */
	ranks: Record<string, number>;
	/** The worst (largest) rank among the required entries. */
	worstRank: number;
	/** 1 / worstRank. */
	worstReciprocal: number;
};

export function scoreCase(
	required: readonly string[],
	ranking: readonly string[],
): CaseScore {
	const rankOf = new Map(ranking.map((entry, index) => [entry, index + 1]));
	const ranks: Record<string, number> = {};
	let worstRank = 0;
	for (const entry of required) {
		const rank = rankOf.get(entry) ?? ranking.length + 1;
		ranks[entry] = rank;
		if (rank > worstRank) worstRank = rank;
	}
	return { ranks, worstRank, worstReciprocal: 1 / worstRank };
}

export type MethodMetrics = {
	evaluated: number;
	/** For each k: how many cases have every required entry within the top-k, and the share. */
	containment: Record<string, { cases: number; rate: number }>;
	/** Mean of 1 / (worst required rank) over the evaluated cases. */
	meanWorstReciprocal: number;
};

export function aggregateMethodMetrics(
	perCase: readonly CaseScore[],
): MethodMetrics {
	const containment: MethodMetrics["containment"] = {};
	for (const k of CONTAINMENT_KS) {
		const cases = perCase.filter((score) => score.worstRank <= k).length;
		containment[String(k)] = {
			cases,
			rate: perCase.length === 0 ? 0 : cases / perCase.length,
		};
	}
	const meanWorstReciprocal =
		perCase.length === 0
			? 0
			: perCase.reduce((sum, score) => sum + score.worstReciprocal, 0) /
				perCase.length;
	return { evaluated: perCase.length, containment, meanWorstReciprocal };
}

export type RerankScorer = (
	pairs: readonly { query: string; passage: string }[],
) => Promise<number[] | null>;

export type CaseResult = {
	caseId: string;
	required: string[];
	/** Per method: each required entry's rank. Only available methods appear. */
	ranks: Partial<Record<MethodId, Record<string, number>>>;
	/** Per method: the worst required entry's rank. */
	worstRank: Partial<Record<MethodId, number>>;
	/** The full ranking per method (all offered entries, best first). */
	rankings: Partial<Record<MethodId, EntryRanking>>;
};

export type SelectionExperimentReport = {
	caseSnapshot: CaseSnapshot;
	runId: string;
	startedAt: string;
	split: "dev";
	cases: {
		/** All cases in the set. */
		total: number;
		/** Cases in the dev split. */
		dev: number;
		/** Dev pipeline cases with a non-empty required set: the metric denominator. */
		evaluated: number;
		/** Dev cases left out of the denominator, by expected kind, with the reason. */
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
	reranker: {
		model: string;
		revision: string | null;
		status: "available" | "unavailable";
		reason: string | null;
		note: string;
	};
	methods: Partial<
		Record<MethodId, { description: string; metrics: MethodMetrics }>
	>;
	unavailableMethods: Partial<Record<MethodId, string>>;
	perCase: CaseResult[];
	/** Cases where the available methods' worst required ranks are not all equal. */
	diffCases: CaseResult[];
};

const RERANKER_NOTE =
	"公開版 cl-nagoya/ruri-reranker-small（ベースモデル）。利用者が配備した再学習版ではなく、その成績とは混ぜない。";

function passagesOf(card: ComponentCard): string[] {
	return cardPassages({
		title: card.title,
		summary: card.summary,
		useWhen: card.useWhen,
		examples: [],
	});
}

/** The vendor Router's ranking path over precomputed vectors (as in RouterSelection). */
function embeddingRanking(
	cards: readonly ComponentCard[],
	perCard: readonly { entry: string; passages: readonly string[] }[],
	passageVectors: readonly number[][],
	queryVector: readonly number[],
): EntryRanking {
	const rows: Array<{ id: string; values: ArrayLike<number> }> = [];
	let offset = 0;
	for (const card of perCard) {
		for (const _passage of card.passages) {
			const values = passageVectors[offset];
			if (values) rows.push({ id: card.entry, values });
			offset += 1;
		}
	}
	const similarity = closestSimilarities(
		rows,
		queryVector,
		new Set(cards.map((c) => c.entry)),
	);
	return rankBy(
		cards.map((c) => ({ id: c.entry })),
		similarity,
	).map((entry) => entry.id);
}

export async function runSelectionExperiment(options: {
	transport: EmbedTransport;
	casesDir?: string;
	/** Scores every (query, passage) pair in one call; null makes emb-rerank unavailable. */
	rerankScorer?: RerankScorer | null;
	rerankProvenance?: { model: string; revision: string | null };
}): Promise<SelectionExperimentReport> {
	const startedAt = new Date().toISOString();
	const runId = crypto.randomUUID();
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
		const caseSnapshot = captureCases(allCases, options.casesDir);
		const devCases = allCases.filter((c) => c.split === "dev");
		const evaluated: EvalCase[] = [];
		const excludedByKind = new Map<string, number>();
		for (const evalCase of devCases) {
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

		// Embed in four batch calls: raw passages, prefixed passages, raw queries,
		// prefixed queries. Every vector compared below must share one space.
		let space: SelectionExperimentReport["embedding"]["space"] | null = null;
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

		const rankingsByCase = new Map<
			string,
			Partial<Record<MethodId, EntryRanking>>
		>();
		for (const [index, evalCase] of evaluated.entries()) {
			const rawQuery = rawQueryVectors[index];
			const prefixedQuery = prefixedQueryVectors[index];
			if (!rawQuery || !prefixedQuery)
				throw new Error(
					`embed transport returned no query vector for ${evalCase.id}`,
				);
			const emb = embeddingRanking(cards, perCard, rawPassageVectors, rawQuery);
			const embPrefix = embeddingRanking(
				cards,
				perCard,
				prefixedPassageVectors,
				prefixedQuery,
			);
			const bm25Ranking = rankFromScores(entries, bm25.score(evalCase.request));
			const rrf = reciprocalRankFusion([emb, bm25Ranking], entries);
			rankingsByCase.set(evalCase.id, {
				emb,
				"emb-prefix": embPrefix,
				bm25: bm25Ranking,
				rrf,
			});
		}

		// Rerank: emb's top-N cards per case, each scored by its best passage.
		const unavailableMethods: Partial<Record<MethodId, string>> = {};
		let rerankerStatus: "available" | "unavailable" = "unavailable";
		let rerankerReason: string | null = null;
		if (!options.rerankScorer) {
			rerankerReason = "no rerank scorer was provided to the experiment";
			unavailableMethods["emb-rerank"] = rerankerReason;
		} else {
			type Pending = {
				caseId: string;
				candidates: { entry: string; passages: readonly string[] }[];
			};
			const pending: Pending[] = [];
			const pairs: { query: string; passage: string }[] = [];
			for (const evalCase of evaluated) {
				const emb = rankingsByCase.get(evalCase.id)?.emb;
				if (!emb) throw new Error(`missing emb ranking for ${evalCase.id}`);
				const candidates = emb.slice(0, RERANK_TOP_N).map((entry) => {
					const card = perCard.find((c) => c.entry === entry);
					if (!card) throw new Error(`unknown candidate entry ${entry}`);
					return { entry, passages: card.passages };
				});
				pending.push({ caseId: evalCase.id, candidates });
				for (const candidate of candidates)
					for (const passage of candidate.passages)
						pairs.push({ query: evalCase.request, passage });
			}
			const scores = await options.rerankScorer(pairs);
			if (!scores) {
				rerankerReason =
					"rerank scorer returned null (helper unavailable or failed)";
				unavailableMethods["emb-rerank"] = rerankerReason;
			} else if (scores.length !== pairs.length) {
				rerankerReason = `rerank scorer answered ${scores.length} scores for ${pairs.length} pairs`;
				unavailableMethods["emb-rerank"] = rerankerReason;
			} else {
				rerankerStatus = "available";
				let offset = 0;
				for (const item of pending) {
					const scored = item.candidates.map((candidate, candIndex) => {
						let best = Number.NEGATIVE_INFINITY;
						for (const _passage of candidate.passages) {
							const value = scores[offset];
							if (value !== undefined && value > best) best = value;
							offset += 1;
						}
						return { entry: candidate.entry, score: best, candIndex };
					});
					scored.sort((a, b) => b.score - a.score || a.candIndex - b.candIndex);
					const emb = rankingsByCase.get(item.caseId)?.emb;
					if (!emb) throw new Error(`missing emb ranking for ${item.caseId}`);
					const ranking = [
						...scored.map((s) => s.entry),
						...emb.slice(RERANK_TOP_N),
					];
					const existing = rankingsByCase.get(item.caseId);
					if (existing) existing["emb-rerank"] = ranking;
				}
			}
		}

		const methodIds = METHOD_IDS.filter(
			(id) => unavailableMethods[id] === undefined,
		);
		const scoresByMethod = new Map<MethodId, CaseScore[]>();
		const perCase: CaseResult[] = [];
		for (const evalCase of evaluated) {
			const required = evalCase.expected.requiredBundles ?? [];
			const rankings = rankingsByCase.get(evalCase.id) ?? {};
			const ranks: CaseResult["ranks"] = {};
			const worstRank: CaseResult["worstRank"] = {};
			for (const methodId of methodIds) {
				const ranking = rankings[methodId];
				if (!ranking) continue;
				const score = scoreCase(required, ranking);
				ranks[methodId] = score.ranks;
				worstRank[methodId] = score.worstRank;
				const list = scoresByMethod.get(methodId) ?? [];
				list.push(score);
				scoresByMethod.set(methodId, list);
			}
			perCase.push({
				caseId: evalCase.id,
				required: [...required],
				ranks,
				worstRank,
				rankings,
			});
		}
		const methods: SelectionExperimentReport["methods"] = {};
		for (const methodId of methodIds) {
			const list = scoresByMethod.get(methodId);
			if (!list) continue;
			methods[methodId] = {
				description: METHOD_DESCRIPTIONS[methodId],
				metrics: aggregateMethodMetrics(list),
			};
		}
		const diffCases = perCase.filter((caseResult) => {
			const worst = methodIds
				.map((id) => caseResult.worstRank[id])
				.filter((value) => value !== undefined);
			return new Set(worst).size > 1;
		});

		return {
			caseSnapshot,
			runId,
			startedAt,
			split: "dev",
			cases: {
				total: allCases.length,
				dev: devCases.length,
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
			reranker: {
				model:
					options.rerankProvenance?.model ?? "cl-nagoya/ruri-reranker-small",
				revision: options.rerankProvenance?.revision ?? null,
				status: rerankerStatus,
				reason: rerankerReason,
				note: RERANKER_NOTE,
			},
			methods,
			unavailableMethods,
			perCase,
			diffCases,
		};
	} finally {
		catalog.close();
	}
}

/** A short Japanese summary of the report (the run's summary.md). */
export function renderSelectionSummary(
	report: SelectionExperimentReport,
): string {
	const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
	const lines: string[] = [
		`# 部品選択実験（Wave B） ${report.runId}`,
		"",
		`- 開始: ${report.startedAt}`,
		`- split: ${report.split}（dev の pipeline ケース ${report.cases.evaluated} 件を評価。dev 全体 ${report.cases.dev} 件中、${report.cases.excluded.map((e) => `${e.kind} ${e.count} 件`).join("・")}は検索の正解が定義できないため分母から除外）`,
		`- 提示カード: ${report.cards} 件（ready+partial）`,
		`- 埋め込み: network=${report.embedding.network}, model=${report.embedding.space.modelId}, revision=${report.embedding.space.revision}, hash=${report.embedding.space.artifactDigest.slice(0, 12)}…, ${report.embedding.space.dimension} 次元`,
		`- リランカ: ${report.reranker.model}（revision ${report.reranker.revision ?? "未記録"}）status=${report.reranker.status}${report.reranker.reason ? `（${report.reranker.reason}）` : ""}。${report.reranker.note}`,
		"",
		"## 方式ごとの指標",
		"",
		"| 方式 | top-3 | top-5 | top-8 | top-12 | 最下位 required の平均逆順位 |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const methodId of METHOD_IDS) {
		const method = report.methods[methodId];
		if (!method) {
			lines.push(
				`| ${methodId} | — | — | — | — | — |（利用不可: ${report.unavailableMethods[methodId] ?? "理由未記録"}）`,
			);
			continue;
		}
		const c = method.metrics.containment;
		lines.push(
			`| ${methodId} | ${pct(c["3"]?.rate ?? 0)} | ${pct(c["5"]?.rate ?? 0)} | ${pct(c["8"]?.rate ?? 0)} | ${pct(c["12"]?.rate ?? 0)} | ${method.metrics.meanWorstReciprocal.toFixed(3)} |`,
		);
	}
	lines.push(
		"",
		"top-k は「required 集合の全入口が上位 k 件に入ったケースの割合」。",
		"",
		`## 方式間で差が出たケース（${report.diffCases.length} 件）`,
		"",
	);
	const spread = (caseResult: CaseResult): number => {
		const worst = Object.values(caseResult.worstRank).filter(
			(value) => value !== undefined,
		);
		return Math.max(...worst) - Math.min(...worst);
	};
	const notable = [...report.diffCases]
		.sort((a, b) => spread(b) - spread(a))
		.slice(0, 10);
	if (notable.length === 0) lines.push("なし。");
	for (const caseResult of notable) {
		const worstText = METHOD_IDS.filter(
			(id) => caseResult.worstRank[id] !== undefined,
		)
			.map((id) => `${id}=${caseResult.worstRank[id]}位`)
			.join(", ");
		lines.push(
			`- ${caseResult.caseId}（required: ${caseResult.required.join(", ")}）: 最下位 required の順位 ${worstText}`,
		);
	}
	lines.push(
		"",
		"全ケースの順位と差分の一覧は results.json を参照。",
		"注意: Router 経路の候補・スコアは、評価ケースと学習文の重なりを確認できるまで未見データでの精度とは呼ばない（plan §9）。本実験は dev split のみ。",
	);
	return `${lines.join("\n")}\n`;
}

/** The per-case record written to the work DB (kept byte-stable via canonicalJson). */
export function caseRecordJson(caseResult: CaseResult): string {
	return canonicalJson({
		caseId: caseResult.caseId,
		required: caseResult.required,
		ranks: caseResult.ranks,
		worstRank: caseResult.worstRank,
	});
}
