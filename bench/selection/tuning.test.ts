import { describe, expect, it } from "bun:test";
import {
	deriveRanking,
	freezeByRule,
	normalizeScores,
	reciprocalRankFusionK,
	weightedFusion,
	type TuningConfigId,
} from "./tuning.ts";
import type { MethodMetrics } from "./experiment.ts";

describe("reciprocalRankFusionK", () => {
	it("rewards entries ranked high by both legs, more sharply for small k", () => {
		const entries = ["a", "b", "c"];
		const fused = reciprocalRankFusionK(
			[
				["a", "b", "c"],
				["b", "a", "c"],
			],
			entries,
			10,
		);
		// a: 1/11 + 1/12, b: 1/12 + 1/11 — tied, broken by entry id.
		expect(fused).toEqual(["a", "b", "c"]);
	});

	it("with a large k approaches a Borda-like count", () => {
		const entries = ["a", "b", "c"];
		const fused = reciprocalRankFusionK(
			[
				["c", "a", "b"],
				["c", "b", "a"],
			],
			entries,
			100,
		);
		expect(fused[0]).toBe("c");
	});
});

describe("normalizeScores", () => {
	it("maps min to 0 and max to 1", () => {
		const out = normalizeScores(
			["a", "b", "c"],
			new Map([
				["a", 2],
				["b", 6],
				["c", 4],
			]),
		);
		expect(out.get("a")).toBe(0);
		expect(out.get("b")).toBe(1);
		expect(out.get("c")).toBe(0.5);
	});

	it("maps a degenerate map to all zeros", () => {
		const out = normalizeScores(
			["a", "b"],
			new Map([
				["a", 3],
				["b", 3],
			]),
		);
		expect(out.get("a")).toBe(0);
		expect(out.get("b")).toBe(0);
	});
});

describe("weightedFusion", () => {
	it("weight 1 follows the embedding leg, weight 0 the BM25 leg", () => {
		const entries = ["a", "b"];
		const emb = new Map([
			["a", 0.9],
			["b", 0.1],
		]);
		const bm25 = new Map([
			["a", 1],
			["b", 9],
		]);
		expect(weightedFusion(entries, emb, bm25, 1)).toEqual(["a", "b"]);
		expect(weightedFusion(entries, emb, bm25, 0)).toEqual(["b", "a"]);
	});
});

describe("deriveRanking", () => {
	it("passes the base legs through unchanged", () => {
		const legs = {
			entries: ["a", "b"],
			embRanking: ["b", "a"],
			embPrefixRanking: ["a", "b"],
			bm25Ranking: ["a", "b"],
			embScores: new Map([
				["a", 0.1],
				["b", 0.9],
			]),
			embPrefixScores: new Map([
				["a", 0.9],
				["b", 0.1],
			]),
			bm25Scores: new Map([
				["a", 5],
				["b", 1],
			]),
		};
		expect(deriveRanking("emb", legs)).toEqual(["b", "a"]);
		expect(deriveRanking("emb-prefix", legs)).toEqual(["a", "b"]);
	});
});

describe("freezeByRule", () => {
	const metrics = (top12: number, mrr: number): MethodMetrics => ({
		evaluated: 60,
		containment: {
			"3": { cases: 0, rate: 0 },
			"5": { cases: 0, rate: 0 },
			"8": { cases: 0, rate: 0 },
			"12": { cases: top12, rate: top12 / 60 },
		},
		meanWorstReciprocal: mrr,
	});

	it("picks the highest top-12 containment", () => {
		const picked = freezeByRule({
			emb: metrics(55, 0.59),
			"emb-prefix": metrics(57, 0.57),
			"rrf-k60": metrics(54, 0.61),
		});
		expect(picked).toBe("emb-prefix" satisfies TuningConfigId);
	});

	it("breaks a top-12 tie by mean worst reciprocal rank", () => {
		const picked = freezeByRule({
			emb: metrics(55, 0.59),
			"rrf-k60": metrics(55, 0.61),
		});
		expect(picked).toBe("rrf-k60");
	});

	it("breaks a full tie by simplicity (earlier wins)", () => {
		const picked = freezeByRule({
			"rrf-k30": metrics(55, 0.6),
			"rrf-k10": metrics(55, 0.6),
		});
		expect(picked).toBe("rrf-k10");
	});

	it("returns null when nothing was evaluated", () => {
		expect(freezeByRule({})).toBeNull();
	});
});
