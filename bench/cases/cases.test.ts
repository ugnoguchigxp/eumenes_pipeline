import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchCatalog } from "../catalog/load.ts";
import { evalCase, loadCases } from "./cases.ts";

const catalog = loadBenchCatalog();
afterAll(() => catalog.close());

const cases = loadCases();
const byId = new Map(cases.map((c) => [c.id, c]));

/** An entry drags a case into the fixture-reported group when it is legacy or fixture-output. */
const fixtureDependent = (entry: string): boolean => {
	const record = catalog.view.all.get(entry);
	if (!record) throw new Error(`unknown entry ${entry}`);
	return (
		record.execution === "unbound" || record.card.output.origin === "fixture"
	);
};

describe("seed cases in data/cases/", () => {
	test("loads the seed set with unique ids", () => {
		expect(cases).toHaveLength(12);
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
	});

	test("covers the P0c categories", () => {
		const kinds = cases.map((c) => c.expected.kind);
		expect(kinds.filter((k) => k === "pipeline").length).toBeGreaterThanOrEqual(
			8,
		);
		expect(kinds).toContain("needs_input");
		expect(kinds).toContain("unsupported");
		// plan §3's example (weather in the original is §3's trio of legacy parts) is present.
		expect(
			byId.get("edo-research-image-music")?.expected.requiredBundles,
		).toEqual(["web.search", "image.create", "music.create"]);
	});

	test("gold references name only offered entries and known materials", () => {
		const offered = new Set(catalog.view.offered.map((r) => r.card.entry));
		for (const c of cases) {
			const bundles = [
				...(c.expected.requiredBundles ?? []),
				...(c.expected.acceptableBundles ?? []),
			];
			for (const entry of bundles)
				expect(offered.has(entry), `${c.id}: ${entry} is not offered`).toBe(
					true,
				);
			for (const material of c.expected.requiredMaterials ?? [])
				expect(
					material === "request" || offered.has(material),
					`${c.id}: material ${material} is neither "request" nor an offered entry`,
				).toBe(true);
		}
	});

	test("usesFixtureContracts matches the catalog facts it claims to summarize", () => {
		for (const c of cases) {
			const bundles = [
				...(c.expected.requiredBundles ?? []),
				...(c.expected.acceptableBundles ?? []),
			];
			expect(c.usesFixtureContracts, c.id).toBe(bundles.some(fixtureDependent));
		}
	});
});

describe("loadCases failure modes", () => {
	const withDir = (files: Record<string, string>): string => {
		const dir = mkdtempSync(join(tmpdir(), "cases-test-"));
		for (const [name, text] of Object.entries(files))
			writeFileSync(join(dir, name), text);
		return dir;
	};
	const good = JSON.stringify({
		id: "ok-case",
		request: "依頼",
		providedMaterials: [],
		expected: { kind: "unsupported" },
		usesFixtureContracts: false,
	});

	test("rejects a file that is not JSON", () => {
		const dir = withDir({ "a.json": "{oops" });
		expect(() => loadCases(dir)).toThrow(/not valid JSON/);
		rmSync(dir, { recursive: true, force: true });
	});

	test("rejects a case that breaks the schema (unknown field, bad entry id)", () => {
		const dir = withDir({
			"a.json": JSON.stringify({ ...JSON.parse(good), gold: "leak" }),
			"b.json": JSON.stringify({
				...JSON.parse(good),
				id: "other",
				expected: { kind: "pipeline", requiredBundles: ["No Such"] },
			}),
		});
		expect(() => loadCases(dir)).toThrow(/invalid case/);
		rmSync(dir, { recursive: true, force: true });
	});

	test("rejects duplicate case ids across files", () => {
		const dir = withDir({ "a.json": good, "b.json": good });
		expect(() => loadCases(dir)).toThrow(/duplicate case id "ok-case"/);
		rmSync(dir, { recursive: true, force: true });
	});

	test("the schema itself rejects a pipeline case whose gold is empty prose", () => {
		expect(
			evalCase.safeParse({
				id: "x",
				request: "",
				providedMaterials: [],
				expected: { kind: "pipeline" },
				usesFixtureContracts: false,
			}).success,
		).toBe(false);
	});
});
