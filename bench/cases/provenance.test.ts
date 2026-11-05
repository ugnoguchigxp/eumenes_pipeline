import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "./cases.ts";
import {
	captureCases,
	readCaseSnapshot,
	sourceProvenance,
} from "./provenance.ts";

describe("run provenance", () => {
	test("retains original case bytes, independently of later files", () => {
		const c = loadCases().find((c) => c.id === "prime-count");
		if (!c) throw new Error("case missing");
		const snapshot = captureCases([c]);
		expect(readCaseSnapshot(snapshot).cases).toEqual([c]);
		expect(snapshot.files[0]?.content).toBe(
			readFileSync("data/cases/prime-count.json", "utf8"),
		);
		const changed = structuredClone(snapshot);
		if (changed.files[0]) changed.files[0].content += " ";
		expect(() => readCaseSnapshot(changed)).toThrow("digest mismatch");
	});
	test("detects a case changing after loading", () => {
		const c = loadCases()[0];
		if (!c) throw new Error("case missing");
		const dir = mkdtempSync(join(tmpdir(), "case-provenance-"));
		writeFileSync(
			join(dir, `${c.id}.json`),
			JSON.stringify({ ...c, request: "changed" }),
		);
		expect(() => captureCases([c], dir)).toThrow("case changed");
	});
	test("source identity is stable and contains no environment files", () => {
		const a = sourceProvenance();
		expect(a).toEqual(sourceProvenance());
		expect(a.files["bench/scoring/score.ts"]).toBeString();
		expect(Object.keys(a.files).some((p) => p.includes(".env"))).toBe(false);
	});
});
