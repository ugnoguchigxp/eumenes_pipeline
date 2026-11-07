import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	symlinkSync,
	cpSync,
	existsSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sourceProvenance } from "../cases/provenance.ts";
import { runFormat } from "../format/run.ts";
import { CONDITIONS } from "../format/conditions.ts";
import { SYNTHETIC_OUTPUTS } from "../format/synthetic.ts";
import { createEvidenceBundle, verifyEvidenceBundle } from "./bundle.ts";

test.each([
	"data/source/eumenes-catalog-2026-11-03.sqlite3",
	"data/contracts/eumenes-contracts-2026-11-03.json",
	"data/contracts/fixture-outputs.json",
])("bundling rejects a changed evaluated input: %s", async (changedPath) => {
	const dir = mkdtempSync(join(tmpdir(), "evidence-input-drift-"));
	const root = join(dir, "source");
	const runsRoot = join(dir, "runs");
	const dbPath = join(dir, "work.sqlite3");
	const report = await runFormat({
		session: "drift",
		runsRoot,
		dbPath,
		caseIds: ["vague-request"],
		formats: ["json"],
	});
	for (const path of Object.keys(sourceProvenance().files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		cpSync(path, join(root, path));
	}
	for (const path of ["data/source", "data/contracts", "vendor/router"])
		cpSync(path, join(root, path), { recursive: true });
	const file = join(root, changedPath);
	chmodSync(file, 0o600);
	writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("\n")]));
	const target = join(dir, "bundle");
	expect(() =>
		createEvidenceBundle({
			runId: report.runId,
			dbPath,
			runsRoot,
			root,
			target,
		}),
	).toThrow("input changed since run");
	expect(existsSync(target)).toBe(false);
});

test("a host replay bundle retains the exact external snapshot after its source changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-host-evidence-"));
	const runsRoot = join(dir, "runs");
	const dbPath = join(dir, "work.sqlite3");
	const hostPromptPath = join(dir, "external-host.json");
	const original = readFileSync(
		"data/contracts/eumenes-compose-prompt.json",
		"utf8",
	);
	writeFileSync(hostPromptPath, original);
	const options = {
		session: "host-evidence",
		runsRoot,
		dbPath,
		hostPromptPath,
		caseIds: ["vague-request"],
		formats: ["json"] as const,
		condition: CONDITIONS.eumenes,
	};
	await runFormat(options);
	const request = JSON.parse(
		readFileSync(
			join(runsRoot, options.session, "requests/vague-request--json.json"),
			"utf8",
		),
	);
	writeFileSync(
		join(runsRoot, options.session, "recordings/vague-request--json.json"),
		JSON.stringify({
			promptDigest: request.promptDigest,
			output: JSON.stringify({
				status: "needs_input",
				questions: ["何を依頼しますか？"],
			}),
		}),
	);
	const scored = await runFormat(options);
	writeFileSync(hostPromptPath, "changed after the completed run");
	const target = join(dir, "bundle");
	createEvidenceBundle({ target, runId: scored.runId, dbPath, runsRoot });
	verifyEvidenceBundle(target);
	const saved = join(target, "data/replay-host-prompt.json");
	expect(readFileSync(saved, "utf8")).toBe(original);
	const replayed = await runFormat({ ...options, hostPromptPath: saved });
	expect(replayed.condition).toEqual(scored.condition);
	expect(replayed.cells).toEqual(scored.cells);
});

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
