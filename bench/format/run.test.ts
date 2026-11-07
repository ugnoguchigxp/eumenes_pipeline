import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, type EvalCase } from "../cases/cases.ts";
import type { FormatId } from "../formats/index.ts";
import {
	ENUM_PURPOSE,
	inferenceDigest,
	TRIAGE_PURPOSE,
} from "../infer/recorded.ts";
import { CONDITIONS } from "./conditions.ts";
import { buildEnumPrompt, enumNoteText, parseEnumOutput } from "./enumerate.ts";
import { buildFormatPrompt } from "./prompt.ts";
import {
	buildHostPrompt,
	loadHostPrompt,
	hostPromptIdentity,
} from "./host-prompt.ts";
import { runFormat } from "./run.ts";
import { SYNTHETIC_OUTPUTS } from "./synthetic.ts";
import { buildTriagePrompt, triageNoteText } from "./triage.ts";

/**
 * End-to-end wiring check with SYNTHETIC outputs (`synthetic.ts`): prompt → recording →
 * replay → parse → authoring → check → mock → score, plus the missing and digest-mismatch
 * paths. Nothing here is a measurement; it proves the bench path, not any model.
 */
describe("bench:format wiring (synthetic recordings)", () => {
	test("the whole path runs and counts every cell, split by fixture dependence", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-wiring-"));
		const session = "wiring";
		const recordingsDir = join(runsRoot, session, "recordings");
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const cases = loadCases();
		mkdirSync(recordingsDir, { recursive: true });
		const writeRecording = (
			caseId: string,
			format: FormatId,
			output: string,
			digestOverride?: string,
		) => {
			const evalCase = cases.find((c) => c.id === caseId);
			if (!evalCase) throw new Error(`case ${caseId} missing`);
			const { system, prompt } = buildFormatPrompt({
				evalCase,
				format,
				cards: catalog.cards,
			});
			writeFileSync(
				join(recordingsDir, `${caseId}--${format}.json`),
				JSON.stringify({
					promptDigest:
						digestOverride ??
						inferenceDigest({ purpose: "compose", system, prompt }),
					output,
				}),
			);
		};
		for (const synthetic of SYNTHETIC_OUTPUTS)
			writeRecording(synthetic.caseId, synthetic.format, synthetic.output);
		// A recording that claims the wrong digest must be refused, never replayed.
		writeRecording("vague-request", "md-yaml", "{}", "0".repeat(64));
		catalog.close();

		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count", "vague-request", "stock-quote"],
			formats: ["json", "md-yaml"],
		});

		const cell = (caseId: string, format: FormatId) =>
			report.cells.find((c) => c.caseId === caseId && c.format === format);

		const good = cell("prime-count", "json");
		expect(good?.status).toBe("scored");
		expect(good?.passed).toBe(true);
		expect(good?.score?.mockCompleted).toBe(true);

		const wrongBundle = cell("prime-count", "md-yaml");
		expect(wrongBundle?.status).toBe("scored");
		expect(wrongBundle?.passed).toBe(false);
		expect(wrongBundle?.score?.score.bundles).toBe(false);
		expect(wrongBundle?.score?.requiredMisses).toEqual(["compute.python"]);
		expect(wrongBundle?.score?.mockCompleted).toBe(true);

		const needsInput = cell("vague-request", "json");
		expect(needsInput?.status).toBe("scored");
		expect(needsInput?.passed).toBe(true);
		expect(needsInput?.score?.stateMatch).toBe(true);

		const broken = cell("stock-quote", "md-yaml");
		expect(broken?.status).toBe("scored");
		expect(broken?.passed).toBe(false);
		expect(broken?.score?.parseOk).toBe(false);
		expect(broken?.score?.parseErrors).toContain("anchor");

		expect(cell("vague-request", "md-yaml")?.status).toBe("digest-mismatch");
		expect(cell("stock-quote", "json")?.status).toBe("missing");

		// The missing cell left a request whose digest is the prompt's digest.
		const requestPath = join(
			runsRoot,
			session,
			"requests",
			"stock-quote--json.json",
		);
		expect(existsSync(requestPath)).toBe(true);
		const requestFile = JSON.parse(readFileSync(requestPath, "utf8")) as {
			promptDigest: string;
			system: string;
			prompt: string;
		};
		expect(requestFile.promptDigest).toBe(
			inferenceDigest({
				purpose: "compose",
				system: requestFile.system,
				prompt: requestFile.prompt,
			}),
		);
		expect(existsSync(join(runsRoot, session, "summary.json"))).toBe(true);

		expect(report.totals).toMatchObject({
			cells: 6,
			scored: 4,
			missing: 1,
			digestMismatch: 1,
			inferenceErrors: 0,
			parseOk: 3,
			authoringOk: 3,
			checkAttempts: 2,
			checkOk: 2,
			stateMatch: 3,
			bundlesOk: 2,
			mockAttempts: 2,
			mockCompleted: 2,
			passed: 2,
		});
		// All three cases are catalog-only: the fixture-dependent group stays empty.
		expect(report.byFormat.json.fixtureDependent.cells).toBe(0);
		expect(report.byFormat.json.catalogOnly.cells).toBe(3);
		// The run records its condition and the tokenizer state; under the test guard the
		// tokenizer helper cannot spawn, so token counts are null rather than invented.
		expect(report.condition).toEqual({
			id: "baseline",
			cardSet: "all",
			cardStyle: "full",
			shots: 0,
			outputStyle: "default",
		});
		expect(report.tokenizer.available).toBe(false);
		for (const cell of report.cells) {
			expect(cell.promptTokens).toBeNull();
			expect(cell.outputTokens).toBeNull();
		}
		const summary = JSON.parse(
			readFileSync(join(runsRoot, session, "summary.json"), "utf8"),
		) as {
			condition: { id: string };
			cells: { caseId: string; promptTokens: number | null }[];
		};
		expect(summary.condition.id).toBe("baseline");
		expect(summary.cells).toHaveLength(6);
		expect(summary.cells.every((c) => c.promptTokens === null)).toBe(true);
	});
});

describe("bench:format conditions (synthetic recordings)", () => {
	const primeOutput = SYNTHETIC_OUTPUTS.find(
		(s) => s.caseId === "prime-count" && s.format === "json",
	)?.output;
	if (!primeOutput) throw new Error("synthetic prime-count/json missing");

	const setup = (
		buildPrompt: (evalCase: EvalCase) => {
			system: string;
			prompt: string;
		},
		output: string = primeOutput,
	) => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-condition-"));
		const session = "cond";
		const recordingsDir = join(runsRoot, session, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		const cases = loadCases();
		const prime = cases.find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const { system, prompt } = buildPrompt(prime);
		writeFileSync(
			join(recordingsDir, "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({
					purpose: "compose",
					system,
					prompt,
				}),
				output,
			}),
		);
		return { runsRoot, session };
	};

	test("compact condition: recordings bind to the compact prompt's digest", async () => {
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const { runsRoot, session } = setup((evalCase) =>
			buildFormatPrompt({
				evalCase,
				format: "json",
				cards: catalog.cards,
				cardStyle: "compact",
			}),
		);
		catalog.close();
		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["json"],
			condition: CONDITIONS.compact,
		});
		expect(report.condition).toEqual({
			id: "compact",
			cardSet: "all",
			cardStyle: "compact",
			shots: 0,
			outputStyle: "default",
		});
		const cell = report.cells[0];
		expect(cell?.status).toBe("scored");
		expect(cell?.passed).toBe(true);
	});

	test("minjson condition: recordings bind to the minified-style prompt's digest", async () => {
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const { runsRoot, session } = setup((evalCase) =>
			buildFormatPrompt({
				evalCase,
				format: "json",
				cards: catalog.cards,
				outputStyle: "minified",
			}),
		);
		catalog.close();
		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["json"],
			condition: CONDITIONS.minjson,
		});
		expect(report.condition).toEqual({
			id: "minjson",
			cardSet: "all",
			cardStyle: "full",
			shots: 0,
			outputStyle: "minified",
		});
		// The synthetic output is JSON.stringify output (already single-line), so it
		// doubles as a minified recording here; what this test pins is the digest
		// binding and the recorded condition, not the whitespace itself.
		const cell = report.cells[0];
		expect(cell?.status).toBe("scored");
		expect(cell?.passed).toBe(true);
	});

	test("eumenes condition: the host's own prompt is sent, read and bound as the host does", async () => {
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const host = loadHostPrompt();
		// The host requires an explicit status and binds the original request: a paraphrased
		// copy passes, recorded as a warning, where the bench's own reading would fail it.
		const paraphrased = JSON.stringify({
			status: "ready",
			definition: { ...JSON.parse(primeOutput), request: "素数を数えて" },
		});
		const { runsRoot, session } = setup(
			(evalCase) => buildHostPrompt({ evalCase, cards: catalog.cards, host }),
			paraphrased,
		);
		catalog.close();
		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["json"],
			condition: CONDITIONS.eumenes,
		});
		expect(report.condition).toEqual({
			id: "eumenes",
			cardSet: "all",
			cardStyle: "full",
			shots: 0,
			outputStyle: "default",
			promptStyle: "eumenes-p0-3",
			hostPrompt: hostPromptIdentity(host),
		});
		expect(report.cells[0]?.status).toBe("scored");
		expect(report.cells[0]?.passed).toBe(true);
		const again = loadBenchCatalog({ policy: "ready+partial" });
		const bare = setup(
			(evalCase) => buildHostPrompt({ evalCase, cards: again.cards, host }),
			primeOutput,
		);
		again.close();
		const bareReport = await runFormat({
			...bare,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["json"],
			condition: CONDITIONS.eumenes,
		});
		expect(bareReport.cells[0]?.passed).toBe(false);
		await expect(
			runFormat({
				session: "cond-host",
				runsRoot: mkdtempSync(join(tmpdir(), "format-condition-")),
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json", "md-yaml"],
				condition: CONDITIONS.eumenes,
			}),
		).rejects.toThrow("json format only");
	});

	test("an explicit historical host revision replays without switching to the current prompt", async () => {
		const hostPromptPath = "data/contracts/eumenes-compose-prompt.json";
		const host = loadHostPrompt(hostPromptPath);
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const recording = setup(
			(evalCase) => buildHostPrompt({ evalCase, cards: catalog.cards, host }),
			JSON.stringify({ status: "ready", definition: JSON.parse(primeOutput) }),
		);
		catalog.close();
		const options = {
			...recording,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["json"] as const,
			condition: CONDITIONS.eumenes,
			hostPromptPath,
			hostToolchainRevisionId: "toolchain:pipeline.execute@1",
		};
		const report = await runFormat(options);
		expect(report.totals.scored).toBe(1);
		expect(report.cells[0]?.passed).toBe(true);
		expect(report.condition.hostPrompt).toEqual(hostPromptIdentity(host));
		await expect(
			runFormat({
				...options,
				hostToolchainRevisionId: "toolchain:pipeline.execute@2",
			}),
		).rejects.toThrow("revision differs");
		await expect(
			runFormat({
				...options,
				condition: CONDITIONS.baseline,
			}),
		).rejects.toThrow("require the eumenes");
	});

	test("candidates: a listed case is offered the subset, others keep all cards", async () => {
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const subset = ["compute.python", "cli.run"];
		const { runsRoot, session } = setup((evalCase) =>
			buildFormatPrompt({
				evalCase,
				format: "json",
				cards: catalog.cards.filter((c) => subset.includes(c.entry)),
			}),
		);
		catalog.close();
		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count", "stock-quote"],
			formats: ["json"],
			condition: {
				id: "subset:deadbeef",
				cardSet: "all",
				cardStyle: "full",
				shots: 0,
				outputStyle: "default",
			},
			candidates: { "prime-count": subset },
		});
		expect(report.condition.cardSet).toBe("subset");
		expect(report.cells.find((c) => c.caseId === "prime-count")?.status).toBe(
			"scored",
		);
		// stock-quote has no recording: its request must offer the full card set.
		const request = JSON.parse(
			readFileSync(
				join(runsRoot, session, "requests", "stock-quote--json.json"),
				"utf8",
			),
		) as { prompt: string };
		expect(request.prompt).toContain("`weather.forecast`");
	});

	test("repair: a mechanically failed cell gets one repair round, scored apart", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-repair-"));
		const session = "repair-wiring";
		const dir = join(runsRoot, session);
		const recordingsDir = join(dir, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const cases = loadCases();
		const prime = cases.find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		// A composing output whose step id uses an underscore: the entry choice is
		// right, the definition fails the authoring schema — a mechanical failure.
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
		writeFileSync(
			join(recordingsDir, "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({ purpose: "compose", system, prompt }),
				output: brokenOutput,
			}),
		);
		const run = (repair: boolean) =>
			runFormat({
				session,
				runsRoot,
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json"],
				...(repair ? { repair: true } : {}),
			});

		// Without the flag there is no repair at all (pre-repair bench behaviour).
		const plain = await run(false);
		expect(plain.cells[0]?.passed).toBe(false);
		expect(plain.cells[0]?.repair).toBeUndefined();
		expect(plain.repair).toBeUndefined();
		expect(existsSync(join(dir, "repair-requests"))).toBe(false);

		// With the flag, the failed cell leaves a repair request and counts as missing.
		const first = await run(true);
		const cell = first.cells[0];
		expect(cell?.status).toBe("scored");
		expect(cell?.authoringOk).toBe(false);
		expect(cell?.repair?.status).toBe("missing");
		expect(cell?.repair?.before).toMatchObject({
			authoringOk: false,
			passed: false,
			bundles: true,
		});
		expect(first.repair).toMatchObject({
			attempted: 1,
			scored: 0,
			missing: 1,
			passedBefore: 0,
			passedAfter: 0,
		});
		const requestPath = join(dir, "repair-requests", "prime-count--json.json");
		const requestFile = JSON.parse(readFileSync(requestPath, "utf8")) as {
			purpose: string;
			system: string;
			prompt: string;
			promptDigest: string;
		};
		expect(requestFile.purpose).toBe("repair");
		expect(requestFile.promptDigest).toBe(
			inferenceDigest({
				purpose: "repair",
				system: requestFile.system,
				prompt: requestFile.prompt,
			}),
		);
		// The repair prompt carries the original output and the machine error only.
		expect(requestFile.prompt).toContain("prime_count");
		expect(requestFile.prompt).toContain("[schema]");
		expect(requestFile.prompt).toContain("steps.0.id");

		// A repair recording that fixes only the id turns the verdict around; the
		// composing verdict itself stays failed (append-only honesty).
		const fixedOutput = primeOutput;
		mkdirSync(join(dir, "repair-recordings"), { recursive: true });
		writeFileSync(
			join(dir, "repair-recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: requestFile.promptDigest,
				output: fixedOutput,
			}),
		);
		const second = await run(true);
		expect(second.cells[0]?.passed).toBe(false);
		expect(second.cells[0]?.repair?.status).toBe("scored");
		expect(second.cells[0]?.repair?.after).toMatchObject({
			authoringOk: true,
			passed: true,
			state: true,
			bundles: true,
			materials: true,
		});
		expect(second.repair).toMatchObject({
			attempted: 1,
			scored: 1,
			passedBefore: 0,
			passedAfter: 1,
		});
		const summary = JSON.parse(
			readFileSync(join(dir, "summary.json"), "utf8"),
		) as {
			repair?: { attempted: number };
			cells: { repair?: { status: string } }[];
		};
		expect(summary.repair?.attempted).toBe(1);
		expect(summary.cells[0]?.repair?.status).toBe("scored");
	});

	test("repair: a digest-mismatched repair recording is refused, not used", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-repair-"));
		const session = "repair-mismatch";
		const dir = join(runsRoot, session);
		mkdirSync(join(dir, "recordings"), { recursive: true });
		mkdirSync(join(dir, "repair-recordings"), { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const cases = loadCases();
		const prime = cases.find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({ purpose: "compose", system, prompt }),
				output: "{not json",
			}),
		);
		writeFileSync(
			join(dir, "repair-recordings", "prime-count--json.json"),
			JSON.stringify({ promptDigest: "0".repeat(64), output: primeOutput }),
		);
		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["json"],
			repair: true,
		});
		expect(report.cells[0]?.repair?.status).toBe("digest-mismatch");
		expect(report.repair).toMatchObject({ attempted: 1, digestMismatch: 1 });
	});

	test("repair: a semantic failure (wrong bundle) is never repair material", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-repair-"));
		const session = "repair-semantic";
		const recordingsDir = join(runsRoot, session, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const cases = loadCases();
		const prime = cases.find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase: prime,
			format: "md-yaml",
			cards: catalog.cards,
		});
		catalog.close();
		const wrongBundle = SYNTHETIC_OUTPUTS.find(
			(s) => s.caseId === "prime-count" && s.format === "md-yaml",
		)?.output;
		if (!wrongBundle) throw new Error("synthetic md-yaml output missing");
		writeFileSync(
			join(recordingsDir, "prime-count--md-yaml.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({ purpose: "compose", system, prompt }),
				output: wrongBundle,
			}),
		);
		const report = await runFormat({
			session,
			runsRoot,
			dbPath: ":memory:",
			caseIds: ["prime-count"],
			formats: ["md-yaml"],
			repair: true,
		});
		expect(report.cells[0]?.passed).toBe(false);
		expect(report.cells[0]?.repair).toBeUndefined();
		expect(report.repair?.attempted).toBe(0);
	});

	test("restore-syntax: a syntactically broken output is recovered only with the flag", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-restore-"));
		const session = "restore-wiring";
		const dir = join(runsRoot, session);
		const recordingsDir = join(dir, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const cases = loadCases();
		const prime = cases.find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		const digest = inferenceDigest({ purpose: "compose", system, prompt });
		const writeOutput = (name: string, output: string) =>
			writeFileSync(
				join(recordingsDir, name),
				JSON.stringify({ promptDigest: digest, output }),
			);
		// The valid definition with a trailing comma: syntax damage only.
		writeOutput("prime-count--json.json", primeOutput.replace(/\}$/, ",}"));
		const run = (restoreSyntax: boolean) =>
			runFormat({
				session,
				runsRoot,
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json"],
				...(restoreSyntax ? { restoreSyntax: true } : {}),
			});

		// Without the flag: the strict parser's failure stands (pre-restore bench),
		// and neither the report nor the summary mentions restore at all.
		const plain = await run(false);
		expect(plain.cells[0]?.status).toBe("scored");
		expect(plain.cells[0]?.score?.parseOk).toBe(false);
		expect(plain.cells[0]?.passed).toBe(false);
		expect(plain.cells[0]?.syntaxRestored).toBeUndefined();
		expect(plain.restore).toBeUndefined();
		const plainSummary = JSON.parse(
			readFileSync(join(dir, "summary.json"), "utf8"),
		) as { restore?: unknown; cells: Record<string, unknown>[] };
		expect(plainSummary.restore).toBeUndefined();
		expect(plainSummary.cells[0]).not.toHaveProperty("syntaxRestored");

		// With the flag: the same recording parses through the restored text and the
		// cell is flagged; the recording file itself is byte-identical afterwards.
		const recordingPath = join(recordingsDir, "prime-count--json.json");
		const recordingBefore = readFileSync(recordingPath, "utf8");
		const restored = await run(true);
		expect(restored.cells[0]?.score?.parseOk).toBe(true);
		expect(restored.cells[0]?.passed).toBe(true);
		expect(restored.cells[0]?.syntaxRestored).toBe(true);
		expect(restored.restore).toEqual({ attempted: 1, recovered: 1 });
		expect(readFileSync(recordingPath, "utf8")).toBe(recordingBefore);
		const summary = JSON.parse(
			readFileSync(join(dir, "summary.json"), "utf8"),
		) as {
			restore?: { attempted: number; recovered: number };
			cells: { syntaxRestored?: boolean }[];
		};
		expect(summary.restore).toEqual({ attempted: 1, recovered: 1 });
		expect(summary.cells[0]?.syntaxRestored).toBe(true);

		// Duplicate keys are ambiguity, not syntax: restore must not rescue them.
		writeOutput(
			"prime-count--json.json",
			primeOutput.replace('"request":', '"request": "重複", "request":'),
		);
		const dup = await run(true);
		expect(dup.cells[0]?.score?.parseOk).toBe(false);
		expect(dup.cells[0]?.score?.parseErrors).toContain("duplicate_key");
		expect(dup.cells[0]?.syntaxRestored).toBe(false);
		expect(dup.restore).toEqual({ attempted: 1, recovered: 0 });
	});

	test("normalize-ids: an id-shape failure is recovered only with the flag", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-normalize-"));
		const session = "normalize-wiring";
		const dir = join(runsRoot, session);
		const recordingsDir = join(dir, "recordings");
		mkdirSync(recordingsDir, { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const cases = loadCases();
		const prime = cases.find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const { system, prompt } = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
		});
		catalog.close();
		const digest = inferenceDigest({ purpose: "compose", system, prompt });
		const writeOutput = (name: string, output: string) =>
			writeFileSync(
				join(recordingsDir, name),
				JSON.stringify({ promptDigest: digest, output }),
			);
		// The valid definition with a snake_case step id (and its reference):
		// an authoring failure on id shape alone.
		writeOutput(
			"prime-count--json.json",
			primeOutput.replaceAll('"count"', '"prime_count"'),
		);
		const run = (normalizeIds: boolean) =>
			runFormat({
				session,
				runsRoot,
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json"],
				...(normalizeIds ? { normalizeIds: true } : {}),
			});

		// Without the flag: the authoring failure stands (pre-normalization bench),
		// and neither the report nor the summary mentions normalization at all.
		const plain = await run(false);
		expect(plain.cells[0]?.status).toBe("scored");
		expect(plain.cells[0]?.authoringOk).toBe(false);
		expect(plain.cells[0]?.passed).toBe(false);
		expect(plain.cells[0]?.idsNormalized).toBeUndefined();
		expect(plain.normalize).toBeUndefined();
		const plainSummary = JSON.parse(
			readFileSync(join(dir, "summary.json"), "utf8"),
		) as { normalize?: unknown; cells: Record<string, unknown>[] };
		expect(plainSummary.normalize).toBeUndefined();
		expect(plainSummary.cells[0]).not.toHaveProperty("idsNormalized");

		// With the flag: the same recording passes the gate through the rewritten
		// definition and the cell is flagged; the recording is byte-identical.
		const recordingPath = join(recordingsDir, "prime-count--json.json");
		const recordingBefore = readFileSync(recordingPath, "utf8");
		const normalized = await run(true);
		expect(normalized.cells[0]?.authoringOk).toBe(true);
		expect(normalized.cells[0]?.passed).toBe(true);
		expect(normalized.cells[0]?.idsNormalized).toBe(true);
		expect(normalized.normalize).toEqual({ attempted: 1, recovered: 1 });
		expect(readFileSync(recordingPath, "utf8")).toBe(recordingBefore);
		const summary = JSON.parse(
			readFileSync(join(dir, "summary.json"), "utf8"),
		) as {
			normalize?: { attempted: number; recovered: number };
			cells: { idsNormalized?: boolean }[];
		};
		expect(summary.normalize).toEqual({ attempted: 1, recovered: 1 });
		expect(summary.cells[0]?.idsNormalized).toBe(true);

		// An id whose rewrite would land on the reserved `request` reference is
		// refused: attempted, not recovered, and the authoring failure stands.
		writeOutput(
			"prime-count--json.json",
			primeOutput.replaceAll('"count"', '"Request"'),
		);
		const refused = await run(true);
		expect(refused.cells[0]?.authoringOk).toBe(false);
		expect(refused.cells[0]?.idsNormalized).toBe(false);
		expect(refused.normalize).toEqual({ attempted: 1, recovered: 0 });
	});

	test("triage: a case composes only with a usable pre-pass conclusion", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-triage-"));
		const session = "triage-wiring";
		const dir = join(runsRoot, session);
		mkdirSync(join(dir, "recordings"), { recursive: true });
		mkdirSync(join(dir, "triage-recordings"), { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const prime = loadCases().find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const triageBuilt = buildTriagePrompt(prime);
		const triageDigest = inferenceDigest({
			purpose: TRIAGE_PURPOSE,
			system: triageBuilt.system,
			prompt: triageBuilt.prompt,
		});
		const noted = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
			triageNote: triageNoteText({ verdict: "proceed", questions: [] }),
		});
		catalog.close();
		const run = () =>
			runFormat({
				session,
				runsRoot,
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json"],
				triage: true,
			});

		// No triage recording: the composing cell is blocked as missing and the
		// triage request is written; nothing is composed without the pre-pass.
		const blocked = await run();
		expect(blocked.cells[0]?.status).toBe("missing");
		expect(blocked.triage).toMatchObject({
			cases: 1,
			concluded: 0,
			missing: 1,
		});
		expect(existsSync(join(dir, "triage-requests", "prime-count.json"))).toBe(
			true,
		);

		// A proceed verdict: the composing prompt carries the note (a different
		// digest), and a recording for that digest scores normally.
		writeFileSync(
			join(dir, "triage-recordings", "prime-count.json"),
			JSON.stringify({
				promptDigest: triageDigest,
				output: '{"verdict": "proceed"}',
			}),
		);
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest({
					purpose: "compose",
					system: noted.system,
					prompt: noted.prompt,
				}),
				output: primeOutput,
			}),
		);
		const scored = await run();
		expect(scored.cells[0]?.passed).toBe(true);
		expect(scored.cells[0]?.triage).toEqual({
			verdict: "proceed",
			questions: [],
		});
		expect(scored.triage).toMatchObject({
			concluded: 1,
			proceed: 1,
			needsInput: 0,
		});

		// An invalid verdict document blocks the cell as an inference error.
		writeFileSync(
			join(dir, "triage-recordings", "prime-count.json"),
			JSON.stringify({
				promptDigest: triageDigest,
				output: "たぶん進めてよいと思います",
			}),
		);
		const invalid = await run();
		expect(invalid.cells[0]?.status).toBe("inference-error");
		expect(invalid.triage).toMatchObject({ concluded: 0, invalid: 1 });
	});

	test("staged: enumeration gates composing, coverage is reported, and the coverage round repairs gaps", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "format-staged-"));
		const session = "staged-wiring";
		const dir = join(runsRoot, session);
		mkdirSync(join(dir, "recordings"), { recursive: true });
		mkdirSync(join(dir, "enum-recordings"), { recursive: true });
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const prime = loadCases().find((c) => c.id === "prime-count");
		if (!prime) throw new Error("seed case prime-count missing");
		const enumOutput =
			'{"items": ["1から100までの素数の個数を計算する", "計算した個数を伝える"]}';
		const enumBuilt = buildEnumPrompt(prime);
		const enumDigest = inferenceDigest({
			purpose: ENUM_PURPOSE,
			system: enumBuilt.system,
			prompt: enumBuilt.prompt,
		});
		const conclusion = parseEnumOutput(enumOutput);
		if (!conclusion) throw new Error("enum conclusion failed to parse");
		const noted = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
			enumNote: enumNoteText(conclusion),
		});
		const composeDigest = inferenceDigest({
			purpose: "compose",
			system: noted.system,
			prompt: noted.prompt,
		});
		catalog.close();
		const marked = ((): string => {
			const def = JSON.parse(primeOutput) as {
				steps: { task: string }[];
			};
			const first = def.steps[0];
			if (!first) throw new Error("synthetic output has no steps");
			first.task = `[w1][w2] ${first.task}`;
			return JSON.stringify(def);
		})();
		const run = (extra: { coverageRepair?: boolean } = {}) =>
			runFormat({
				session,
				runsRoot,
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json"],
				staged: true,
				...extra,
			});

		// No enumeration recording: the composing cell is blocked as missing and
		// the enumeration request is written.
		const blocked = await run();
		expect(blocked.cells[0]?.status).toBe("missing");
		expect(blocked.staged).toMatchObject({
			cases: 1,
			concluded: 0,
			missing: 1,
		});
		expect(existsSync(join(dir, "enum-requests", "prime-count.json"))).toBe(
			true,
		);

		// Enumeration + a marked composing output: scored with full coverage,
		// and the markers do not leak into the scored definition (it passes).
		writeFileSync(
			join(dir, "enum-recordings", "prime-count.json"),
			JSON.stringify({ promptDigest: enumDigest, output: enumOutput }),
		);
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({ promptDigest: composeDigest, output: marked }),
		);
		const scored = await run();
		expect(scored.cells[0]?.passed).toBe(true);
		expect(scored.cells[0]?.coverage).toEqual({
			total: 2,
			covered: 2,
			uncovered: [],
		});
		expect(scored.staged).toMatchObject({ concluded: 1, items: 2 });

		// The same definition without markers: coverage reports the gap while
		// the verdict itself is untouched (coverage never gates the score).
		writeFileSync(
			join(dir, "recordings", "prime-count--json.json"),
			JSON.stringify({ promptDigest: composeDigest, output: primeOutput }),
		);
		const gapped = await run();
		expect(gapped.cells[0]?.passed).toBe(true);
		expect(gapped.cells[0]?.coverage).toEqual({
			total: 2,
			covered: 0,
			uncovered: ["w1", "w2"],
		});

		// With the coverage review on, the gap becomes a repair round whose
		// prompt names the uncovered items as machine errors.
		const review = await run({ coverageRepair: true });
		expect(review.cells[0]?.repair?.status).toBe("missing");
		const repairRequest = JSON.parse(
			readFileSync(
				join(dir, "repair-requests", "prime-count--json.json"),
				"utf8",
			),
		) as { prompt: string; promptDigest: string };
		expect(repairRequest.prompt).toContain(
			"[coverage] w1: 1から100までの素数の個数を計算する",
		);
		expect(repairRequest.prompt).toContain(
			"[coverage] w2: 計算した個数を伝える",
		);

		// A repair recording that adds the markers closes the gap.
		mkdirSync(join(dir, "repair-recordings"), { recursive: true });
		writeFileSync(
			join(dir, "repair-recordings", "prime-count--json.json"),
			JSON.stringify({
				promptDigest: repairRequest.promptDigest,
				output: marked,
			}),
		);
		const repaired = await run({ coverageRepair: true });
		expect(repaired.cells[0]?.repair?.status).toBe("scored");
		expect(repaired.cells[0]?.repair?.after?.passed).toBe(true);
		expect(repaired.cells[0]?.repair?.coverageAfter).toEqual({
			total: 2,
			covered: 2,
		});
		expect(repaired.repair).toMatchObject({ attempted: 1, scored: 1 });
	});

	test("candidates naming an unoffered entry fail before the run starts", async () => {
		await expect(
			runFormat({
				session: "cond-bad",
				runsRoot: mkdtempSync(join(tmpdir(), "format-condition-")),
				dbPath: ":memory:",
				caseIds: ["prime-count"],
				formats: ["json"],
				candidates: { "prime-count": ["no.such.entry"] },
			}),
		).rejects.toThrow("not offered");
		await expect(
			runFormat({
				session: "cond-bad",
				runsRoot: mkdtempSync(join(tmpdir(), "format-condition-")),
				dbPath: ":memory:",
				candidates: { "no-such-case": ["compute.python"] },
			}),
		).rejects.toThrow("unknown case id");
	});
});
