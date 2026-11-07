import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../catalog/load.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import { buildFormatPrompt } from "../format/prompt.ts";
import { CONDITIONS } from "../format/conditions.ts";
import { buildHostPrompt, loadHostPrompt } from "../format/host-prompt.ts";
import {
	buildEnumPrompt,
	enumNoteText,
	parseEnumOutput,
} from "../format/enumerate.ts";
import { runFormat } from "../format/run.ts";
import { SYNTHETIC_OUTPUTS } from "../format/synthetic.ts";
import { ENUM_PURPOSE, inferenceDigest } from "../infer/recorded.ts";
import { buildRunExport, renderExportMarkdown } from "./export.ts";

/**
 * The export is a reader's view of the work db: totals recomputed from score rows must
 * reproduce the runner's summary exactly, gold provenance must pin the case files, and a
 * tampered summary must be caught. Synthetic recordings only — wiring, not measurement.
 */
describe("bench:export (synthetic recordings)", () => {
	const primeOutput = SYNTHETIC_OUTPUTS.find(
		(s) => s.caseId === "prime-count" && s.format === "json",
	)?.output;
	if (!primeOutput) throw new Error("synthetic prime-count/json missing");

	test.each(["paraphrased", "bare", "bom"] as const)(
		"host export reproduces the scored reading: %s",
		async (kind) => {
			const runsRoot = mkdtempSync(join(tmpdir(), "export-host-"));
			const dbPath = join(runsRoot, "work.sqlite3");
			const session = `host-${kind}`;
			const dir = join(runsRoot, session, "recordings");
			mkdirSync(dir, { recursive: true });
			const catalog = loadBenchCatalog();
			const evalCase = loadCases().find((c) => c.id === "prime-count")!;
			const built = buildHostPrompt({
				evalCase,
				cards: catalog.cards,
				host: loadHostPrompt(),
			});
			catalog.close();
			const original = JSON.parse(primeOutput);
			const wrapped = JSON.stringify({
				status: "ready",
				definition: { ...original, request: "素数を数えて" },
			});
			const output =
				kind === "bare"
					? primeOutput
					: kind === "bom"
						? `\uFEFF${wrapped}`
						: wrapped;
			writeFileSync(
				join(dir, "prime-count--json.json"),
				JSON.stringify({
					promptDigest: inferenceDigest({ purpose: "compose", ...built }),
					output,
				}),
			);
			const run = await runFormat({
				session,
				runsRoot,
				dbPath,
				caseIds: [evalCase.id],
				formats: ["json"],
				condition: CONDITIONS.eumenes,
			});
			const exported = buildRunExport({ runId: run.runId, dbPath, runsRoot });
			const cell = exported.cells[0]!;
			expect(cell.status).toBe("scored");
			expect(cell.authoringOk).toBe(kind === "paraphrased");
			expect(cell.definition).toEqual(kind === "paraphrased" ? original : null);
			const db = new Database(dbPath, { readonly: true });
			try {
				expect(
					db
						.query("SELECT output_text FROM trials WHERE trial_id=?")
						.get(cell.trialId),
				).toEqual({ output_text: output });
				if (kind === "paraphrased") {
					expect(cell.passed).toBe(true);
					expect(cell.checks).toContainEqual(
						expect.objectContaining({
							code: "request_mismatch",
							severity: "warning",
						}),
					);
					expect(
						db
							.query(
								"SELECT reference_digests FROM mock_calls WHERE trial_id=?",
							)
							.get(cell.trialId),
					).toEqual({
						reference_digests: JSON.stringify([sha256(evalCase.request)]),
					});
				}
			} finally {
				db.close();
			}
		},
	);

	test("staged compose and repair export the marker-free definitions that were executed", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "export-staged-"));
		const dbPath = join(runsRoot, "work.sqlite3");
		const session = "staged-export";
		const dir = join(runsRoot, session);
		for (const child of ["recordings", "enum-recordings", "repair-recordings"])
			mkdirSync(join(dir, child), { recursive: true });
		const evalCase = loadCases().find((c) => c.id === "prime-count")!;
		const catalog = loadBenchCatalog();
		const enumOutput = JSON.stringify({
			items: ["素数を数える", "個数を伝える"],
		});
		const enumeration = parseEnumOutput(enumOutput)!;
		const built = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: catalog.cards,
			enumNote: enumNoteText(enumeration),
		});
		catalog.close();
		writeFileSync(
			join(dir, "enum-recordings", "prime-count.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({
					purpose: ENUM_PURPOSE,
					...buildEnumPrompt(evalCase),
				}),
				output: enumOutput,
			}),
		);
		const original = JSON.parse(primeOutput);
		const marked = (markers: string) => {
			const definition = structuredClone(original);
			definition.steps[0].task = `${markers} ${definition.steps[0].task}`;
			return JSON.stringify(definition);
		};
		const composeOutput = marked("[w1]");
		const repairOutput = marked("[w1][w2]");
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({ purpose: "compose", ...built }),
				output: composeOutput,
			}),
		);
		const options = {
			session,
			runsRoot,
			dbPath,
			caseIds: [evalCase.id],
			formats: ["json"] as const,
			staged: true,
			coverageRepair: true,
		};
		await runFormat(options);
		const request = JSON.parse(
			readFileSync(
				join(dir, "repair-requests", "prime-count--json.json"),
				"utf8",
			),
		);
		writeFileSync(
			join(dir, "repair-recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: request.promptDigest,
				output: repairOutput,
			}),
		);
		const run = await runFormat(options);
		const exported = buildRunExport({ runId: run.runId, dbPath, runsRoot });
		const cell = exported.cells[0]!;
		expect(cell.passed).toBe(true);
		expect(cell.repair?.after?.passed).toBe(true);
		expect(cell.definition).toEqual(original);
		expect(cell.repair?.definition).toEqual(original);
		const db = new Database(dbPath, { readonly: true });
		try {
			for (const [trialId, output] of [
				[cell.trialId, composeOutput],
				[cell.repair!.trialId, repairOutput],
			]) {
				expect(
					db
						.query("SELECT output_text FROM trials WHERE trial_id=?")
						.get(trialId!),
				).toEqual({ output_text: output });
				expect(
					db
						.query("SELECT request_digest FROM mock_calls WHERE trial_id=?")
						.get(trialId!),
				).toEqual({ request_digest: sha256(original.steps[0].task) });
			}
		} finally {
			db.close();
		}
	});
	test("later gold changes cannot be attributed to the historical run", async () => {
		const root = mkdtempSync(join(tmpdir(), "export-gold-drift-"));
		const runsRoot = join(root, "runs");
		const dbPath = join(root, "bench.sqlite3");
		const recordingsDir = join(runsRoot, "gold-drift", "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		writeRecording(recordingsDir, "prime-count", primeOutput);
		const run = await runFormat({
			session: "gold-drift",
			runsRoot,
			dbPath,
			caseIds: ["prime-count"],
			formats: ["json"],
		});
		const before = buildRunExport({ runId: run.runId, dbPath, runsRoot });
		const casesDir = join(root, "changed-cases");
		cpSync("data/cases", casesDir, { recursive: true });
		const path = join(casesDir, "prime-count.json");
		const changed = JSON.parse(readFileSync(path, "utf8"));
		changed.expected.requiredBundles = ["web.search"];
		writeFileSync(path, JSON.stringify(changed));
		expect(() =>
			buildRunExport({ runId: run.runId, dbPath, runsRoot, casesDir }),
		).toThrow("case snapshot drift");
		const after = buildRunExport({ runId: run.runId, dbPath, runsRoot });
		expect(after.cases).toEqual(before.cases);
		expect(after.provenance.casesPinned).toBe(true);
		expect(after.inputs.source).toBeObject();
		expect(after.totals).toEqual(before.totals);
	});

	function writeRecording(
		recordingsDir: string,
		caseId: string,
		output: string,
	) {
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const evalCase = loadCases().find((c) => c.id === caseId);
		if (!evalCase) throw new Error(`case ${caseId} missing`);
		const { system, prompt } = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		writeFileSync(
			join(recordingsDir, `${caseId}--json.json`),
			JSON.stringify({
				promptDigest: inferenceDigest({ purpose: "compose", system, prompt }),
				output,
			}),
		);
	}

	test("a compose run exports with provenance and a clean cross-check", async () => {
		const root = mkdtempSync(join(tmpdir(), "export-wiring-"));
		const runsRoot = join(root, "runs");
		const dbPath = join(root, "bench.sqlite3");
		const session = "export-wiring";
		const recordingsDir = join(runsRoot, session, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		writeRecording(recordingsDir, "prime-count", primeOutput);
		// stock-quote gets no recording: the cell must export as missing, never dropped.

		const report = await runFormat({
			session,
			runsRoot,
			dbPath,
			caseIds: ["prime-count", "stock-quote"],
			formats: ["json"],
		});
		const exp = buildRunExport({ runId: report.runId, dbPath, runsRoot });

		expect(exp.run.runId).toBe(report.runId);
		expect(exp.run.parentRunId).toBeNull();
		expect(exp.run.status).toBe("completed");
		expect(exp.condition?.id).toBe("baseline");
		expect(exp.provenance.catalogVersion).toBeString();
		expect(exp.provenance.contractVersion).toBe("p0-3");
		expect(exp.provenance.contractVersionAtExport).toBe("p0-3");

		const prime = exp.cases.find((c) => c.id === "prime-count");
		expect(prime?.split).toBe("dev");
		expect(prime?.expectedKind).toBe("pipeline");
		expect(prime?.goldSha256).toBe(
			sha256(readFileSync("data/cases/prime-count.json", "utf8")),
		);

		const good = exp.cells.find((c) => c.caseId === "prime-count");
		expect(good?.status).toBe("scored");
		expect(good?.passed).toBe(true);
		expect(good?.authoringOk).toBe(true);
		expect(good?.score?.stateMatch).toBe(true);
		expect(good?.model).toBe("agent-model");
		// Saved form: the recording's output is minified JSON, yet the export carries
		// the definition as structured data (the CLI serializes the export pretty) —
		// same content, readable saved form, raw output untouched in the db.
		expect(good?.definition?.steps).toHaveLength(1);
		expect(good?.definition?.steps[0]?.id).toBe("count");
		expect(good?.definition?.steps[0]?.bundle).toBe("compute.python");
		expect(JSON.parse(JSON.stringify(good?.definition))).toEqual(
			JSON.parse(primeOutput),
		);
		const missing = exp.cells.find((c) => c.caseId === "stock-quote");
		expect(missing?.status).toBe("missing");
		expect(missing?.passed).toBeNull();
		expect(missing?.score).toBeNull();
		expect(missing?.definition).toBeNull();

		// Totals recomputed from the db reproduce the runner's own summary numbers.
		expect(exp.totals).toEqual(report.totals);
		expect(exp.byFormat).toEqual(report.byFormat);
		expect(exp.summaryCrossCheck.runMatches).toBe(true);
		expect(exp.summaryCrossCheck.totalsEqual).toBe(true);
		expect(exp.summaryCrossCheck.cellsEqual).toBe(true);
		expect(exp.summaryCrossCheck.differences).toEqual([]);
	});

	test("a tampered summary is reported, not silently trusted", async () => {
		const root = mkdtempSync(join(tmpdir(), "export-tamper-"));
		const runsRoot = join(root, "runs");
		const dbPath = join(root, "bench.sqlite3");
		const session = "export-tamper";
		const recordingsDir = join(runsRoot, session, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		writeRecording(recordingsDir, "prime-count", primeOutput);
		const report = await runFormat({
			session,
			runsRoot,
			dbPath,
			caseIds: ["prime-count"],
			formats: ["json"],
		});
		const summaryPath = join(runsRoot, session, "summary.json");
		const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
			totals: { passed: number };
		};
		summary.totals.passed += 1;
		writeFileSync(summaryPath, JSON.stringify(summary));

		const exp = buildRunExport({ runId: report.runId, dbPath, runsRoot });
		expect(exp.summaryCrossCheck.runMatches).toBe(true);
		expect(exp.summaryCrossCheck.totalsEqual).toBe(false);
		expect(exp.summaryCrossCheck.differences.length).toBeGreaterThan(0);
		// The export's own totals still come from the db.
		expect(exp.totals.passed).toBe(report.totals.passed);
	});

	test("a repair run exports before/after verdicts from its own trials", async () => {
		const root = mkdtempSync(join(tmpdir(), "export-repair-"));
		const runsRoot = join(root, "runs");
		const dbPath = join(root, "bench.sqlite3");
		const session = "export-repair";
		const dir = join(runsRoot, session);
		const recordingsDir = join(dir, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		const brokenOutput = JSON.stringify({
			request: "1から100までの素数の個数を計算して教えてください",
			steps: [
				{
					id: "prime_count",
					bundle: "compute.python",
					task: "1から100までの素数の個数を計算する",
					from: ["request"],
					result: "素数の個数",
				},
			],
			output: { from: ["prime_count"], deliver: "計算した素数の個数を伝える" },
		});
		writeRecording(recordingsDir, "prime-count", brokenOutput);
		const run = () =>
			runFormat({
				session,
				runsRoot,
				dbPath,
				caseIds: ["prime-count"],
				formats: ["json"],
				repair: true,
			});
		await run();
		const requestFile = JSON.parse(
			readFileSync(
				join(dir, "repair-requests", "prime-count--json.json"),
				"utf8",
			),
		) as { promptDigest: string };
		mkdirSync(join(dir, "repair-recordings"), { recursive: true });
		writeFileSync(
			join(dir, "repair-recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: requestFile.promptDigest,
				output: primeOutput,
			}),
		);
		const second = await run();

		const exp = buildRunExport({ runId: second.runId, dbPath, runsRoot });
		const cell = exp.cells[0];
		expect(cell?.passed).toBe(false);
		// The broken compose output has no saved definition; the repaired one does.
		expect(cell?.definition).toBeNull();
		expect(cell?.repair?.status).toBe("scored");
		expect(cell?.repair?.before.passed).toBe(false);
		expect(cell?.repair?.after?.passed).toBe(true);
		expect(cell?.repair?.definition?.steps[0]?.id).toBe("count");
		expect(exp.repair).toMatchObject({
			attempted: 1,
			scored: 1,
			passedBefore: 0,
			passedAfter: 1,
		});
		expect(exp.summaryCrossCheck.repairEqual).toBe(true);
		expect(exp.summaryCrossCheck.totalsEqual).toBe(true);
	});

	test("a restored cell exports its flag, its definition and the restore totals", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "export-restored-"));
		const dbPath = join(runsRoot, "work.sqlite3");
		const session = "synthetic-export-restore";
		const dir = join(runsRoot, session);
		mkdirSync(join(dir, "recordings"), { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const evalCase = loadCases().find((c) => c.id === "prime-count");
		if (!evalCase) throw new Error("case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		// Trailing comma: syntax damage only; without restore this output cannot parse.
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({
					purpose: "compose",
					system,
					prompt,
				}),
				output: primeOutput.replace(/\}$/, ",}"),
			}),
		);
		const report = await runFormat({
			session,
			runsRoot,
			dbPath,
			caseIds: ["prime-count"],
			formats: ["json"],
			restoreSyntax: true,
		});
		expect(report.restore).toEqual({ attempted: 1, recovered: 1 });

		const exp = buildRunExport({ runId: report.runId, dbPath, runsRoot });
		const cell = exp.cells[0];
		expect(cell?.syntaxRestored).toBe(true);
		expect(cell?.passed).toBe(true);
		// The saved definition is re-derived through the same restore the runner used.
		expect(cell?.definition).not.toBeNull();
		expect(cell?.definition?.steps[0]?.bundle).toBe("compute.python");
		expect(exp.restore).toEqual({ attempted: 1, recovered: 1 });
		expect(exp.config.restoreSyntax).toBe(true);
		expect(exp.config.restoreEngine).toBe("jsonrepair@3.15.0");
		expect(exp.summaryCrossCheck.totalsEqual).toBe(true);
		expect(exp.summaryCrossCheck.restoreEqual).toBe(true);
		expect(exp.summaryCrossCheck.differences).toEqual([]);
		expect(renderExportMarkdown(exp)).toContain("## Syntax restore");
	});

	test("a normalized cell exports its flag, its saved definition and the normalize totals", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "export-normalized-"));
		const dbPath = join(runsRoot, "work.sqlite3");
		const session = "synthetic-export-normalize";
		const dir = join(runsRoot, session);
		mkdirSync(join(dir, "recordings"), { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const evalCase = loadCases().find((c) => c.id === "prime-count");
		if (!evalCase) throw new Error("case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		// A snake_case step id (and its reference): an authoring failure on id
		// shape alone; without normalization this output cannot pass the gate.
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({
					purpose: "compose",
					system,
					prompt,
				}),
				output: primeOutput.replaceAll('"count"', '"prime_count"'),
			}),
		);
		const report = await runFormat({
			session,
			runsRoot,
			dbPath,
			caseIds: ["prime-count"],
			formats: ["json"],
			normalizeIds: true,
		});
		expect(report.normalize).toEqual({ attempted: 1, recovered: 1 });

		const exp = buildRunExport({ runId: report.runId, dbPath, runsRoot });
		const cell = exp.cells[0];
		expect(cell?.idsNormalized).toBe(true);
		expect(cell?.passed).toBe(true);
		// The saved definition is re-derived through the same gate: rewritten ids.
		expect(cell?.definition?.steps[0]?.id).toBe("prime-count");
		expect(cell?.definition?.steps[0]?.bundle).toBe("compute.python");
		expect(exp.normalize).toEqual({ attempted: 1, recovered: 1 });
		expect(exp.config.normalizeIds).toBe(true);
		expect(exp.config.normalizeVersion).toBe("step-id-normalize-v1");
		expect(exp.summaryCrossCheck.totalsEqual).toBe(true);
		expect(exp.summaryCrossCheck.normalizeEqual).toBe(true);
		expect(exp.summaryCrossCheck.differences).toEqual([]);
		expect(renderExportMarkdown(exp)).toContain("## Step-id normalization");
	});

	test("an unknown run id fails loudly", () => {
		const root = mkdtempSync(join(tmpdir(), "export-unknown-"));
		const dbPath = join(root, "bench.sqlite3");
		expect(() =>
			buildRunExport({
				runId: "00000000-0000-0000-0000-000000000000",
				dbPath,
				runsRoot: join(root, "runs"),
			}),
		).toThrow();
	});
});
