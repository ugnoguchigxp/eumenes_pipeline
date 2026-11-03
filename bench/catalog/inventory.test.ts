import { afterAll, describe, expect, test } from "bun:test";
import { summarize } from "./inventory.ts";
import { loadBenchCatalog } from "./load.ts";

const catalog = loadBenchCatalog();
afterAll(() => catalog.close());

describe("inventory of the 2026-11-03 snapshot", () => {
	const { records } = catalog;
	const enabled = records.filter((r) => r.enabled);

	test("matches the counts in plan §4", () => {
		expect(records).toHaveLength(27);
		expect(enabled).toHaveLength(26);
		const bound = enabled.filter((r) => r.evidence.bindingRevisionId);
		expect(bound).toHaveLength(17);
		const kinds = Object.fromEntries(
			["command", "instant", "session"].map((k) => [
				k,
				bound.filter((r) => r.execution === k).length,
			]),
		);
		expect(kinds).toEqual({ command: 13, instant: 2, session: 2 });
		expect(enabled.filter((r) => r.execution === "unbound")).toHaveLength(9);
	});

	test("excludes exactly the disabled, session and pipeline entries, each with a reason", () => {
		const excluded = records.filter((r) => r.support === "excluded");
		expect(excluded.map((r) => r.card.entry).sort()).toEqual([
			"pipeline.studio",
			"task.execute",
			"ui.compose",
		]);
		expect(excluded.every((r) => r.reasons.length > 0)).toBe(true);
	});

	test("never guesses a bundle: legacy entries have none, bound ones cite their binding document", () => {
		for (const r of records) {
			if (r.card.bundle === null) expect(r.evidence.bundleSource).toBeNull();
			else expect(r.evidence.bundleSource).toBe("binding-document");
		}
		expect(
			records
				.filter((r) => r.execution === "unbound")
				.every((r) => r.card.bundle === null),
		).toBe(true);
	});

	test("fixture contracts are marked as such and never count as ready", () => {
		const fixtures = records.filter((r) => r.card.output.origin === "fixture");
		expect(fixtures.map((r) => r.card.entry).sort()).toEqual([
			"image.create",
			"music.create",
		]);
		expect(fixtures.every((r) => r.support === "partial")).toBe(true);
	});

	test("cards carry no internal tools, profiles, adapters or revisions", () => {
		const keys = new Set(catalog.cards.flatMap((c) => Object.keys(c)));
		for (const internal of [
			"toolRevisionIds",
			"adapterRef",
			"profile",
			"skill",
			"evidence",
			"revisionId",
		])
			expect(keys.has(internal)).toBe(false);
	});

	test("coverage is reported against all enabled toolchains", () => {
		const summary = summarize(records);
		expect(
			summary.ready.length + summary.partial.length + summary.excluded.length,
		).toBe(27);
		expect(summary.coverage.ready).toBeCloseTo(summary.ready.length / 26);
	});

	test("the catalog version is stable for the same inputs", () => {
		const again = loadBenchCatalog();
		expect(again.view.version).toBe(catalog.view.version);
		again.close();
	});

	test("the snapshot is read-only", () => {
		expect(catalog.snapshot.sha256).toBe(catalog.snapshot.manifest.sha256);
	});
});
