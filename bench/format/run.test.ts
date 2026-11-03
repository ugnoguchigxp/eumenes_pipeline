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
import { inferenceDigest } from "../infer/recorded.ts";
import { CONDITIONS } from "./conditions.ts";
import { buildFormatPrompt } from "./prompt.ts";
import { runFormat } from "./run.ts";
import { SYNTHETIC_OUTPUTS } from "./synthetic.ts";

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
				output: primeOutput,
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
		});
		const cell = report.cells[0];
		expect(cell?.status).toBe("scored");
		expect(cell?.passed).toBe(true);
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
