import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFormat } from "../format/run.ts";
import { SYNTHETIC_OUTPUTS } from "../format/synthetic.ts";
import { createEvidenceBundle, verifyEvidenceBundle } from "./bundle.ts";

test("portable evidence pins code, cases, original outputs and database, rejects missing or changed bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-evidence-"));
	const runsRoot = join(dir, "runs");
	const dbPath = join(dir, "work.sqlite3");
	const session = "evidence";
	await runFormat({
		session,
		runsRoot,
		dbPath,
		caseIds: ["prime-count"],
		formats: ["json"],
	});
	const request = JSON.parse(
		readFileSync(
			join(runsRoot, session, "requests/prime-count--json.json"),
			"utf8",
		),
	);
	const output = SYNTHETIC_OUTPUTS.find(
		(s) => s.caseId === "prime-count" && s.format === "json",
	)?.output;
	writeFileSync(
		join(runsRoot, session, "recordings/prime-count--json.json"),
		JSON.stringify({ promptDigest: request.promptDigest, output }),
	);
	const scored = await runFormat({
		session,
		runsRoot,
		dbPath,
		caseIds: ["prime-count"],
		formats: ["json"],
		restoreSyntax: true,
		normalizeIds: true,
	});
	const target = join(dir, "bundle");
	const manifest = createEvidenceBundle({
		target,
		runId: scored.runId,
		dbPath,
		runsRoot,
	});
	expect(verifyEvidenceBundle(target)).toEqual(manifest);
	expect(manifest.files["data/replay-cases/prime-count.json"]).toBeString();
	expect(manifest.files["data/replay-source.sqlite3"]).toBeString();
	const portableDb = new Database(join(target, "data/replay-source.sqlite3"), {
		readonly: true,
	});
	expect(
		portableDb
			.query("SELECT status FROM runs WHERE run_id=?")
			.get(scored.runId),
	).toEqual({ status: "completed" });
	portableDb.close();
	expect(
		Object.keys(manifest.files).some((p) => p.endsWith("summary.json")),
	).toBe(false);
	expect(() =>
		createEvidenceBundle({ target, runId: scored.runId, dbPath, runsRoot }),
	).toThrow("already exists");
	writeFileSync(join(target, "bench/scoring/score.ts"), "changed");
	expect(() => verifyEvidenceBundle(target)).toThrow("digest mismatch");
	const incomplete = join(dir, "incomplete");
	mkdirSync(incomplete);
	expect(() => verifyEvidenceBundle(incomplete)).toThrow();
});

test("a manifest path cannot follow a file or directory symlink outside the bundle", () => {
	const root = mkdtempSync(join(tmpdir(), "evidence-link-")),
		outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "record.json"), "{}");
	for (const kind of ["file", "directory"]) {
		const bundle = join(root, kind);
		mkdirSync(bundle);
		const path = kind === "file" ? "record.json" : "linked/record.json";
		symlinkSync(
			kind === "file" ? join(outside, "record.json") : outside,
			join(bundle, kind === "file" ? "record.json" : "linked"),
		);
		writeFileSync(
			join(bundle, "evidence-manifest.json"),
			JSON.stringify({
				version: 1,
				runId: "fixture",
				sourceSha256: "fixture",
				files: { [path]: createHash("sha256").update("{}").digest("hex") },
			}),
		);
		expect(() => verifyEvidenceBundle(bundle)).toThrow("symlink");
	}
});
