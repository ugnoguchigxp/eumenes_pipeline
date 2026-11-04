import { describe, expect, test } from "bun:test";
import { sha256 } from "../catalog/load.ts";
import {
	aggregateMethodMetrics,
	charNgramTokens,
	createBm25Index,
	rankFromScores,
	reciprocalRankFusion,
	runSelectionExperiment,
	scoreCase,
} from "./experiment.ts";
import type { EmbedTransport } from "./port.ts";

/**
 * A fixed-dimension deterministic transport for plumbing tests: hashed character-bigram
 * counts. Rankings it produces prove the experiment's wiring only, never quality (the
 * same caveat as the stub transport, but with a stable vector space across calls).
 */
const testTransport: EmbedTransport = {
	network: "test",
	async embed(texts) {
		const dimension = 256;
		const vectors = texts.map((text) => {
			const vector = Array.from({ length: dimension }, () => 0);
			for (let i = 0; i + 2 <= text.length; i++) {
				const gram = text.slice(i, i + 2);
				let hash = 0;
				for (const ch of gram) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
				const index = hash % dimension;
				vector[index] = (vector[index] ?? 0) + 1;
			}
			const norm = Math.hypot(...vector);
			return norm > 0 ? vector.map((v) => v / norm) : vector;
		});
		return {
			space: {
				modelId: "test-transport",
				revision: "0",
				artifactDigest: sha256("test-transport-v1"),
				dimension,
			},
			vectors,
		};
	},
};

describe("charNgramTokens", () => {
	test("strips whitespace and emits 2-grams then 3-grams", () => {
		expect(charNgramTokens("あい う")).toEqual(["あい", "いう", "あいう"]);
	});
	test("short texts yield fewer tokens", () => {
		expect(charNgramTokens("あ")).toEqual([]);
		expect(charNgramTokens("あい")).toEqual(["あい"]);
	});
});

describe("bm25", () => {
	const index = createBm25Index([
		{ entry: "weather", passages: ["天気予報: 今日と明日の天気を答える"] },
		{ entry: "stock", passages: ["株価: 特定の会社の現在の株価を答える"] },
	]);
	test("a lexical hit outranks a miss; misses score 0", () => {
		const scores = index.score("明日の天気は");
		expect(scores.get("weather")).toBeGreaterThan(0);
		expect(scores.get("stock")).toBe(0);
		const ranking = rankFromScores(["stock", "weather"], scores);
		expect(ranking).toEqual(["weather", "stock"]);
	});
	test("zero-score ties fall back to entry-id order", () => {
		const scores = index.score("全く関係のない依頼");
		const ranking = rankFromScores(["weather", "stock"], scores);
		expect(ranking).toEqual(["stock", "weather"]);
	});
});

describe("reciprocalRankFusion", () => {
	test("fuses two rankings with k=60", () => {
		const fused = reciprocalRankFusion(
			[
				["a", "b", "c"],
				["b", "c", "a"],
			],
			["a", "b", "c"],
		);
		expect(fused).toEqual(["b", "a", "c"]);
	});
});

describe("scoreCase / aggregateMethodMetrics", () => {
	test("worst required rank and its reciprocal", () => {
		const score = scoreCase(["x", "y"], ["a", "x", "b", "y"]);
		expect(score.ranks).toEqual({ x: 2, y: 4 });
		expect(score.worstRank).toBe(4);
		expect(score.worstReciprocal).toBe(0.25);
	});
	test("containment counts cases whose worst required rank is within k", () => {
		const metrics = aggregateMethodMetrics([
			{ ranks: {}, worstRank: 2, worstReciprocal: 0.5 },
			{ ranks: {}, worstRank: 5, worstReciprocal: 0.2 },
		]);
		expect(metrics.evaluated).toBe(2);
		expect(metrics.containment["3"]).toEqual({ cases: 1, rate: 0.5 });
		expect(metrics.containment["5"]).toEqual({ cases: 2, rate: 1 });
		expect(metrics.meanWorstReciprocal).toBeCloseTo(0.35);
	});
});

describe("runSelectionExperiment (test transport, synthetic)", () => {
	test("evaluates the dev pipeline cases and reports every method", async () => {
		const report = await runSelectionExperiment({
			transport: testTransport,
			rerankScorer: async (pairs) => pairs.map((_, i) => pairs.length - i),
		});
		expect(report.split).toBe("dev");
		expect(report.cases.dev).toBe(73);
		expect(report.cases.evaluated).toBe(61);
		const excluded = Object.fromEntries(
			report.cases.excluded.map((e) => [e.kind, e.count]),
		);
		expect(excluded).toEqual({ needs_input: 7, unsupported: 5 });
		expect(report.cards).toBe(24);
		expect(report.perCase).toHaveLength(61);
		expect(Object.keys(report.methods).sort()).toEqual([
			"bm25",
			"emb",
			"emb-prefix",
			"emb-rerank",
			"rrf",
		]);
		for (const caseResult of report.perCase)
			for (const ranking of Object.values(caseResult.rankings))
				expect(ranking).toHaveLength(24);
		expect(report.reranker.status).toBe("available");
	});
	test("a null rerank scorer makes only emb-rerank unavailable", async () => {
		const report = await runSelectionExperiment({
			transport: testTransport,
			rerankScorer: async () => null,
		});
		expect(report.reranker.status).toBe("unavailable");
		expect(report.unavailableMethods["emb-rerank"]).toContain("null");
		expect(report.methods["emb-rerank"]).toBeUndefined();
		expect(report.methods.emb).toBeDefined();
	});
});
