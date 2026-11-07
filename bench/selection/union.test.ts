import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../cases/cases.ts";
import { sha256 } from "../catalog/load.ts";
import { runSelectionTuning } from "./tuning.ts";
import { runUnionAnalysis, setContainsAll, unionPresented } from "./union.ts";

describe("union recorded input identity", () => {
	async function fixture() {
		const root = mkdtempSync(join(tmpdir(), "union-identity-"));
		const casesDir = join(root, "cases");
		mkdirSync(casesDir);
		const evalCase = loadCases().find((c) => c.id === "prime-count")!;
		const casePath = join(casesDir, `${evalCase.id}.json`);
		writeFileSync(casePath, JSON.stringify(evalCase));
		const recorded = await runSelectionTuning({
			casesDir,
			split: "dev",
			configIds: ["emb-prefix"],
			transport: {
				network: "offline-fixture",
				embed: async (texts) => ({
					space: {
						modelId: "fixture",
						revision: "1",
						artifactDigest: sha256("fixture"),
						dimension: 2,
					},
					vectors: texts.map(() => [1, 1]),
				}),
			},
		});
		const recordedResultsPath = join(root, "results.json");
		writeFileSync(recordedResultsPath, JSON.stringify(recorded));
		return { casesDir, casePath, evalCase, recorded, recordedResultsPath };
	}

	test("unchanged inputs preserve source identity and embedding provenance", async () => {
		const { recorded, ...input } = await fixture();
		const report = runUnionAnalysis(input);
		expect(report.evaluated).toBe(1);
		expect(report.caseSnapshot).toEqual(recorded.caseSnapshot);
		expect(report).toMatchObject({
			sourceRunId: recorded.runId,
			embedding: recorded.embedding,
			sourceResultsSha256: sha256(
				readFileSync(input.recordedResultsPath, "utf8"),
			),
		});
	});

	test.each(["request", "materials", "gold"] as const)(
		"rejects changed %s with the same case id",
		async (change) => {
			const { evalCase, casePath, ...input } = await fixture();
			const changed = structuredClone(evalCase);
			if (change === "request")
				changed.request = "1から200までの素数の個数を計算して教えてください";
			if (change === "materials")
				changed.providedMaterials = [{ name: "numbers.txt", kind: "text" }];
			if (change === "gold") changed.expected.requiredBundles = ["web.search"];
			writeFileSync(casePath, JSON.stringify(changed));
			expect(() => runUnionAnalysis(input)).toThrow("case snapshot");
		},
	);

	test.each([
		"catalog",
		"snapshot",
		"duplicate-case",
		"duplicate-ranking",
		"unknown-ranking",
		"legacy",
		"embedding",
	] as const)(
		"rejects unverifiable or malformed results: %s",
		async (change) => {
			const { recorded, ...input } = await fixture();
			let changed: unknown = recorded;
			if (change === "catalog")
				changed = {
					...recorded,
					catalog: { ...recorded.catalog, version: "different" },
				};
			if (change === "snapshot")
				changed = {
					...recorded,
					caseSnapshot: { ...recorded.caseSnapshot, digest: "0".repeat(64) },
				};
			if (change === "duplicate-case")
				changed = {
					...recorded,
					perCase: [...recorded.perCase, recorded.perCase[0]],
				};
			if (change === "duplicate-ranking" || change === "unknown-ranking") {
				const perCase = structuredClone(recorded.perCase);
				const ranking = perCase[0]!.rankings["emb-prefix"]!;
				ranking[1] =
					change === "duplicate-ranking" ? ranking[0]! : "unregistered.entry";
				changed = { ...recorded, perCase };
			}
			if (change === "legacy")
				changed = { ...recorded, caseSnapshot: undefined };
			if (change === "embedding")
				changed = { ...recorded, embedding: undefined };
			writeFileSync(input.recordedResultsPath, JSON.stringify(changed));
			expect(() => runUnionAnalysis(input)).toThrow();
		},
	);
});

describe("unionPresented", () => {
	test("keeps the emb-prefix top-12 order, then appends unseen BM25 entries in BM25 order", () => {
		const emb = [
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
		];
		const bm25 = ["x", "b", "y", "a", "z"];
		expect(unionPresented(emb, bm25, 5)).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"x",
			"y",
			"z",
		]);
	});

	test("k=0 is exactly the emb-prefix top-12 baseline", () => {
		const emb = [
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
		];
		expect(unionPresented(emb, ["x", "y"], 0)).toEqual(emb.slice(0, 12));
	});

	test("adds nothing when the BM25 top-k is already inside the base set", () => {
		const emb = [
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
		];
		expect(unionPresented(emb, ["c", "a", "l"], 3)).toEqual(emb.slice(0, 12));
	});

	test("never duplicates an entry and never shrinks the base set", () => {
		const emb = ["a", "b", "c"];
		const bm25 = ["a", "a", "d", "d", "e"];
		const presented = unionPresented(emb, bm25, 5, 2);
		expect(presented).toEqual(["a", "b", "d", "e"]);
		expect(new Set(presented).size).toBe(presented.length);
	});
});

describe("setContainsAll", () => {
	test("requires every required entry to be presented", () => {
		expect(setContainsAll(["a", "b"], ["x", "a", "b"])).toBe(true);
		expect(setContainsAll(["a", "b"], ["a", "x"])).toBe(false);
		expect(setContainsAll([], ["a"])).toBe(true);
	});
});
