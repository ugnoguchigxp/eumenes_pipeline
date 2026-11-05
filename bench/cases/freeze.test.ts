import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCases } from "./cases.ts";
import {
	assertSeparatedGroups,
	freezeEvaluation,
	verifyFreeze,
} from "./freeze.ts";

test("final protocol refuses group leakage, case/policy drift and unplanned sessions", () => {
	const base = loadCases()[0]!;
	expect(() =>
		assertSeparatedGroups(
			[{ ...base, split: "holdout", group: "shared" }],
			[{ ...base, id: "different", group: "shared" }],
		),
	).toThrow("overlaps");
	const dir = mkdtempSync(join(tmpdir(), "freeze-eval-"));
	const casesDir = join(dir, "cases");
	mkdirSync(casesDir);
	const c = {
		...base,
		id: "new-final-id",
		split: "holdout",
		group: "new-final-family",
	};
	const casePath = join(casesDir, `${c.id}.json`);
	writeFileSync(casePath, JSON.stringify(c));
	const policyPath = join(dir, "policy.json");
	writeFileSync(policyPath, "{}");
	const path = join(dir, "freeze.json");
	const freeze = freezeEvaluation({
		path,
		casesDir,
		policyPath,
		id: "fixture",
		sessions: ["approved"],
		protocol: { repetitions: 1 },
	});
	expect(verifyFreeze(path, "approved", policyPath, casesDir)).toEqual(freeze);
	expect(() => verifyFreeze(path, "extra")).toThrow("not in frozen");
	expect(() =>
		freezeEvaluation({
			path,
			casesDir,
			policyPath,
			id: "fixture",
			sessions: ["approved"],
			protocol: {},
		}),
	).toThrow();
	writeFileSync(casePath, JSON.stringify({ ...c, request: "changed" }));
	expect(() => verifyFreeze(path, "approved", policyPath, casesDir)).toThrow(
		"cases changed",
	);
	writeFileSync(policyPath, '{"changed":true}');
	expect(() => verifyFreeze(path, "approved", policyPath)).toThrow(
		"policy changed",
	);
	const saved = JSON.parse(readFileSync(path, "utf8"));
	saved.protocol.repetitions = 2;
	writeFileSync(path, JSON.stringify(saved));
	expect(() => verifyFreeze(path, "approved")).toThrow("digest mismatch");
});

test("exposed recording regrades are explicit diagnostic data, never silently a new holdout", () => {
	const dir = mkdtempSync(join(tmpdir(), "regrade-freeze-"));
	const casesDir = join(dir, "cases");
	mkdirSync(casesDir);
	const c = loadCases()[0]!;
	writeFileSync(join(casesDir, `${c.id}.json`), JSON.stringify(c));
	const policyPath = join(dir, "policy.json");
	writeFileSync(policyPath, "{}");
	expect(() =>
		freezeEvaluation({
			path: join(dir, "invalid.json"),
			casesDir,
			policyPath,
			id: "bad-holdout",
			sessions: ["fixture"],
			protocol: {},
		}),
	).toThrow();
	const regrade = freezeEvaluation({
		path: join(dir, "regrade.json"),
		casesDir,
		policyPath,
		id: "explicit-regrade",
		sessions: ["fixture"],
		protocol: { intent: "recording-regrade" },
	});
	expect(regrade.protocol.intent).toBe("recording-regrade");
});
