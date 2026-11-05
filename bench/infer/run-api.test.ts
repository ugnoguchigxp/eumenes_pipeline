import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	createEvidenceBundle,
	verifyEvidenceBundle,
} from "../export/bundle.ts";
import { verifyApiRecording } from "./provenance.ts";
import { RecordedInference } from "./recorded.ts";
import { freezeEvaluation } from "../cases/freeze.ts";
import { BASELINE_CONDITION } from "../format/conditions.ts";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
	mkdirSync,
	copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFormat } from "../format/run.ts";
import { SYNTHETIC_OUTPUTS } from "../format/synthetic.ts";
import { buildRunExport } from "../export/export.ts";
import { runApiInference } from "./run-api.ts";

test("API repair preserves legacy composition provenance and requires its own manifest", async () => {
	const root = mkdtempSync(join(tmpdir(), "api-repair-mixed-"));
	const runsRoot = join(root, "runs");
	const dbPath = join(root, "work.sqlite3");
	const budgetPath = join(root, "policy.json");
	const session = "mixed-repair";
	writePolicy(budgetPath);
	const options = {
		session,
		runsRoot,
		dbPath,
		caseIds: ["prime-count"],
		formats: ["json"] as const,
		repair: true,
	};
	await runFormat(options);
	const request = JSON.parse(
		readFileSync(
			join(runsRoot, session, "requests/prime-count--json.json"),
			"utf8",
		),
	);
	const correct = SYNTHETIC_OUTPUTS.find(
		(x) => x.caseId === "prime-count" && x.format === "json",
	)!.output;
	const bad = JSON.parse(correct);
	bad.steps[0].from = ["missing"];
	const path = join(runsRoot, session, "recordings/prime-count--json.json");
	writeFileSync(
		path,
		JSON.stringify({
			promptDigest: request.promptDigest,
			output: JSON.stringify(bad),
		}),
	);
	const before = readFileSync(path, "utf8");
	const casesDir = join(root, "cases");
	mkdirSync(casesDir);
	copyFileSync(
		"data/cases/prime-count.json",
		join(casesDir, "prime-count.json"),
	);
	const freezePath = join(root, "freeze.json");
	freezeEvaluation({
		path: freezePath,
		id: "repair-fixture",
		casesDir,
		policyPath: budgetPath,
		sessions: [session],
		protocol: {
			intent: "recording-regrade",
			formatMethod: {
				condition: BASELINE_CONDITION,
				formats: ["json"],
				repair: true,
				restoreSyntax: false,
				normalizeIds: false,
				triage: false,
				staged: false,
				coverageRepair: false,
				candidates: null,
			},
			apiSessions: {
				[session]: {
					provider: "openai",
					model: "fixture",
					phase: "repair",
					requestCount: 1,
				},
			},
		},
	});
	const failed = await runFormat({ ...options, casesDir, freezePath });
	expect(failed.repair?.missing).toBe(1);
	let calls = 0;
	const repaired = await runApiInference({
		session,
		runsRoot,
		dbPath,
		budgetPath,
		provider: "openai",
		model: "fixture",
		phase: "repair",
		freezePath,
		env: { OPEN_AI_API_KEY: "fake-key" },
		fetcher: async () => {
			calls++;
			return Response.json({
				model: "fixture",
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 20 },
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: correct }],
					},
				],
			});
		},
	});
	expect(repaired.completed).toBe(true);
	const scored = await runFormat(options);
	expect(scored.repair?.passedAfter).toBe(1);
	expect(calls).toBe(1);
	expect(readFileSync(path, "utf8")).toBe(before);
	const exported = buildRunExport({ runId: scored.runId, dbPath, runsRoot });
	expect(exported.config.evidence).toBe("agent-model");
	expect(exported.config.repairEvidence).toBe("api-replay");
	expect(exported.inputs.apiRepairSources).toBeObject();
	unlinkSync(
		join(
			runsRoot,
			session,
			"api-provenance/repair-recordings/prime-count--json.json",
		),
	);
	await expect(runFormat(options)).rejects.toThrow("provenance missing");
});

function writePolicy(budgetPath: string) {
	writeFileSync(
		budgetPath,
		JSON.stringify({
			id: "test",
			ceilingUsd: 1,
			approvedCeilingUsd: 1,
			maxOutputTokens: 100,
			timeoutMs: 1000,
			note: "fixture",
			profiles: [
				{
					provider: "openai",
					model: "fixture",
					contextTokensCeiling: 1000,
					inputUsdPerMillionCeiling: 1,
					outputUsdPerMillionCeiling: 1,
					pricingSource: "https://example.test",
					pricingCheckedAt: "fixture",
					settings: {},
				},
			],
		}),
	);
}

test("API calls and offline replay retain their separate provenance and never overwrite a recording", async () => {
	const root = mkdtempSync(join(tmpdir(), "api-replay-test-"));
	const runsRoot = join(root, "runs");
	const dbPath = join(root, "bench.sqlite3");
	const session = "fixture-api";
	const budgetPath = join(root, "policy.json");
	writePolicy(budgetPath);
	await runFormat({
		session,
		runsRoot,
		dbPath,
		caseIds: ["prime-count"],
		formats: ["json"],
	});
	const output = SYNTHETIC_OUTPUTS.find(
		(c) => c.caseId === "prime-count" && c.format === "json",
	)?.output;
	if (!output) throw new Error("fixture missing");
	let calls = 0;
	const options = {
		session,
		runsRoot,
		dbPath,
		budgetPath,
		provider: "openai" as const,
		model: "fixture",
		env: { OPEN_AI_API_KEY: "secret-sample" },
		fetcher: async () => {
			calls++;
			return Response.json({
				model: "fixture",
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 20 },
				output: [
					{ type: "message", content: [{ type: "output_text", text: output }] },
				],
			});
		},
	};
	const api = await runApiInference(options);
	expect(api.completed).toBe(true);
	expect(calls).toBe(1);
	const scored = await runFormat({
		session,
		runsRoot,
		dbPath,
		caseIds: ["prime-count"],
		formats: ["json"],
	});
	expect(scored.totals.passed).toBe(1);
	const exp = buildRunExport({ runId: scored.runId, runsRoot, dbPath });
	expect(exp.config.evidence).toBe("api-replay");
	expect(exp.cells[0]?.model).toBe("fixture");
	expect(exp.inputs.apiSources).toBeObject();
	// The derived session contains no original API request of its own.
	for (const dir of ["recordings", "api-provenance/recordings"]) {
		mkdirSync(join(runsRoot, "derived", dir), { recursive: true });
		copyFileSync(
			join(runsRoot, session, dir, "prime-count--json.json"),
			join(runsRoot, "derived", dir, "prime-count--json.json"),
		);
	}
	const derived = await runFormat({
		session: "derived",
		runsRoot,
		dbPath,
		caseIds: ["prime-count"],
		formats: ["json"],
	});
	const target = join(root, "portable");
	const manifest = createEvidenceBundle({
		runId: derived.runId,
		dbPath,
		runsRoot,
		target,
	});
	expect(
		manifest.files[
			`data/runs/format/${session}/requests/prime-count--json.json`
		],
	).toBeString();
	verifyEvidenceBundle(target);
	const records = RecordedInference.fromDirectory(
		join(target, "data/runs/format/derived/recordings"),
	);
	const db = new Database(join(target, "data/replay-source.sqlite3"), {
		readonly: true,
	});
	try {
		expect(() =>
			verifyApiRecording({
				db,
				runsRoot: join(target, "data/runs/format"),
				file: "prime-count--json.json",
				source: records.provenance.get("prime-count--json.json")!,
				recording: records.files.get("prime-count--json.json")!,
				provider: "openai",
				model: "fixture",
				phase: "compose",
			}),
		).not.toThrow();
	} finally {
		db.close();
	}

	await expect(runApiInference(options)).rejects.toThrow("already exists");
	expect(calls).toBe(1);
	const path = join(runsRoot, session, "recordings", "prime-count--json.json");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	saved.output = "tampered";
	writeFileSync(path, JSON.stringify(saved));
	await expect(
		runFormat({
			session,
			runsRoot,
			dbPath,
			caseIds: ["prime-count"],
			formats: ["json"],
		}),
	).rejects.toThrow("provenance mismatch");
});
