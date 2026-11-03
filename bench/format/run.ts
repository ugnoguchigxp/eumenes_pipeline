/**
 * bench:format — the format comparison runner (plan §10 P0c/P0d).
 *
 * One invocation = one work-db run over (case × format) cells under ONE fixed condition: the
 * shared prompt template (`prompt.ts`) with every offered card, differing only in the output
 * format. Inference is agent-model (`bench/infer/recorded.ts`): the runner never calls a
 * model. For each cell it builds the prompt, digests it, and looks for the recording the
 * generation step prepared; a cell without a recording gets a request file under
 * `<session>/requests/` and is counted as missing — never skipped silently, never filled in.
 * A recording whose digest does not match the current prompt is refused, not used.
 *
 * Present recordings run the whole evaluator path: parse (format parser) → authoring
 * validation (the P0b `AuthoringOutcome` contract) → `checkDefinition` → mock execution →
 * `scoreCase`. Trials, model calls, check issues, mock calls and score rows are recorded in
 * the work db; the run finishes `completed` when the sweep itself ran to completion (cell
 * outcomes are data, recorded per cell), `failed` on bench errors.
 *
 * Sessions: `--session <name>` names `data/runs/format/<name>/` holding `requests/` and
 * `recordings/`. Re-running a session after recordings arrive is a NEW work-db run (append-
 * only: finished trials are never rewritten), exactly like a resumed experiment (plan §10).
 * Reporting splits fixture-dependent cases (`usesFixtureContracts`) from catalog-only cases
 * in every count (plan §4).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDefinition } from "../../src/check.ts";
import {
	authoringOutcome,
	type AuthoringOutcome,
} from "../../src/contracts/authoring.ts";
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, type EvalCase } from "../cases/cases.ts";
import { FORMAT_PARSERS, FORMAT_IDS, type FormatId } from "../formats/index.ts";
import type { ParseResult } from "../formats/outcome.ts";
import {
	COMPOSE_PURPOSE,
	inferenceDigest,
	RecordedInference,
	type RecordingFile,
} from "../infer/recorded.ts";
import { runPlan } from "../mock/driver.ts";
import { MockHost } from "../mock/host.ts";
import {
	DEFAULT_ATTEMPT_SEED,
	type AttemptResults,
} from "../scoring/evaluate.ts";
import { scoreCase, type CaseScore } from "../scoring/score.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";
import {
	buildFormatPrompt,
	CARDS_RENDERING,
	PROMPT_TEMPLATE_VERSION,
} from "./prompt.ts";

export const DEFAULT_RUNS_ROOT = "data/runs/format";
export const FORMAT_SCORER = "bench-format-v1";

const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type FormatCellStatus =
	"scored" | "missing" | "digest-mismatch" | "inference-error";

export type FormatCellReport = {
	caseId: string;
	format: FormatId;
	fixtureDependent: boolean;
	status: FormatCellStatus;
	/** The parsed outcome satisfied the P0b `AuthoringOutcome` contract. */
	authoringOk?: boolean;
	/** The cell verdict: the scorer's `passed` gated by the authoring contract. */
	passed?: boolean;
	score?: CaseScore;
};

export type FormatGroupSummary = {
	cells: number;
	scored: number;
	missing: number;
	digestMismatch: number;
	inferenceErrors: number;
	parseOk: number;
	authoringOk: number;
	/** Ready cells that reached `checkDefinition`, and how many passed it. */
	checkAttempts: number;
	checkOk: number;
	stateMatch: number;
	bundlesOk: number;
	/** Cells whose plan ran on the mock, and how many completed with every step adopted. */
	mockAttempts: number;
	mockCompleted: number;
	passed: number;
};

export type FormatRunReport = {
	runId: string;
	sessionDir: string;
	cells: FormatCellReport[];
	byFormat: Record<
		FormatId,
		{
			catalogOnly: FormatGroupSummary;
			fixtureDependent: FormatGroupSummary;
			total: FormatGroupSummary;
		}
	>;
	totals: FormatGroupSummary;
};

const emptyGroup = (): FormatGroupSummary => ({
	cells: 0,
	scored: 0,
	missing: 0,
	digestMismatch: 0,
	inferenceErrors: 0,
	parseOk: 0,
	authoringOk: 0,
	checkAttempts: 0,
	checkOk: 0,
	stateMatch: 0,
	bundlesOk: 0,
	mockAttempts: 0,
	mockCompleted: 0,
	passed: 0,
});

function addCell(group: FormatGroupSummary, cell: FormatCellReport): void {
	group.cells += 1;
	if (cell.status === "missing") group.missing += 1;
	if (cell.status === "digest-mismatch") group.digestMismatch += 1;
	if (cell.status === "inference-error") group.inferenceErrors += 1;
	if (cell.status !== "scored" || !cell.score) return;
	group.scored += 1;
	const score = cell.score;
	if (score.parseOk) group.parseOk += 1;
	if (cell.authoringOk) group.authoringOk += 1;
	if (score.checkOk !== null) {
		group.checkAttempts += 1;
		if (score.checkOk) group.checkOk += 1;
	}
	if (score.stateMatch) group.stateMatch += 1;
	if (score.score.bundles) group.bundlesOk += 1;
	if (score.mockCompleted !== null) {
		group.mockAttempts += 1;
		if (score.mockCompleted) group.mockCompleted += 1;
	}
	if (cell.passed) group.passed += 1;
}

/** The P0b contract gate: a parsed outcome still has to be a valid `AuthoringOutcome`. */
function validateAuthoring(parse: ParseResult): AuthoringOutcome | null {
	if (!parse.ok) return null;
	const outcome = parse.outcome;
	const candidate =
		outcome.kind === "ready"
			? { status: "ready", definition: outcome.definition }
			: outcome.kind === "needs_input"
				? {
						status: "needs_input",
						questions: outcome.questions,
						...(outcome.note !== undefined ? { note: outcome.note } : {}),
					}
				: { status: "unsupported", reasons: outcome.reasons };
	const parsed = authoringOutcome.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

export type FormatRunOptions = {
	session: string;
	runsRoot?: string;
	dbPath?: string;
	casesDir?: string;
	formats?: readonly FormatId[];
	caseIds?: readonly string[];
	seed?: string;
};

export async function runFormat(
	options: FormatRunOptions,
): Promise<FormatRunReport> {
	if (!SESSION_PATTERN.test(options.session))
		throw new Error(
			`invalid session name "${options.session}" (letters, digits, . _ -, up to 64 chars)`,
		);
	const sessionDir = join(
		options.runsRoot ?? DEFAULT_RUNS_ROOT,
		options.session,
	);
	const requestsDir = join(sessionDir, "requests");
	const recordingsDir = join(sessionDir, "recordings");
	mkdirSync(requestsDir, { recursive: true });
	mkdirSync(recordingsDir, { recursive: true });

	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	const allCases = loadCases(options.casesDir);
	const cases = options.caseIds
		? allCases.filter((c) => options.caseIds?.includes(c.id))
		: allCases;
	if (options.caseIds && cases.length !== options.caseIds.length)
		throw new Error(
			`unknown case id(s): ${options.caseIds.filter((id) => !cases.some((c) => c.id === id)).join(", ")}`,
		);
	const formats = options.formats ?? FORMAT_IDS;
	const seed = options.seed ?? DEFAULT_ATTEMPT_SEED;
	const work = openWorkDb(options.dbPath ?? DEFAULT_WORK_DB);
	const runId = work.startRun({
		kind: "format",
		config: {
			evidence: "agent-model",
			formats,
			promptTemplate: PROMPT_TEMPLATE_VERSION,
			cardsRendering: CARDS_RENDERING,
			cards: catalog.cards.length,
			policy: catalog.policy,
			seed,
			session: options.session,
		},
		inputs: {
			snapshotSha256: catalog.snapshot.sha256,
			contractsSha256: catalog.contracts.contractsSha256,
			fixturesSha256: catalog.contracts.fixturesSha256,
			catalogVersion: catalog.view.version,
			caseIds: cases.map((c) => c.id),
		},
	});

	const cells: FormatCellReport[] = [];
	let sweepDone = false;
	try {
		const { inference, files } = RecordedInference.fromDirectory(recordingsDir);
		for (const evalCase of cases) {
			for (const format of formats) {
				cells.push(
					await runCell({
						evalCase,
						format,
						files,
						inference,
						requestsDir,
						catalog,
						work,
						runId,
						seed,
					}),
				);
			}
		}
		sweepDone = true;
	} finally {
		work.finishRun(runId, sweepDone ? "completed" : "failed");
		work.close();
		catalog.close();
	}

	const byFormat = {} as FormatRunReport["byFormat"];
	for (const format of formats) {
		const group = {
			catalogOnly: emptyGroup(),
			fixtureDependent: emptyGroup(),
			total: emptyGroup(),
		};
		for (const cell of cells.filter((c) => c.format === format)) {
			addCell(
				cell.fixtureDependent ? group.fixtureDependent : group.catalogOnly,
				cell,
			);
			addCell(group.total, cell);
		}
		byFormat[format] = group;
	}
	const totals = emptyGroup();
	for (const cell of cells) addCell(totals, cell);
	const report: FormatRunReport = {
		runId,
		sessionDir,
		cells,
		byFormat,
		totals,
	};
	writeFileSync(
		join(sessionDir, "summary.json"),
		`${JSON.stringify({ runId, byFormat, totals }, null, "\t")}\n`,
	);
	return report;
}

type CellContext = {
	evalCase: EvalCase;
	format: FormatId;
	files: Map<string, RecordingFile>;
	inference: RecordedInference;
	requestsDir: string;
	catalog: ReturnType<typeof loadBenchCatalog>;
	work: ReturnType<typeof openWorkDb>;
	runId: string;
	seed: string;
};

async function runCell(ctx: CellContext): Promise<FormatCellReport> {
	const { evalCase, format } = ctx;
	const base: FormatCellReport = {
		caseId: evalCase.id,
		format,
		fixtureDependent: evalCase.usesFixtureContracts,
		status: "missing",
	};
	const { system, prompt } = buildFormatPrompt({
		evalCase,
		format,
		cards: ctx.catalog.cards,
	});
	const request = { purpose: COMPOSE_PURPOSE, system, prompt };
	const digest = inferenceDigest(request);
	const fileName = `${evalCase.id}--${format}.json`;
	const trialId = ctx.work.startTrial({
		runId: ctx.runId,
		caseId: evalCase.id,
		condition: format,
		attempt: 1,
		phase: "compose",
	});

	const recording = ctx.files.get(fileName);
	if (!recording) {
		writeFileSync(
			join(ctx.requestsDir, fileName),
			`${JSON.stringify(
				{
					caseId: evalCase.id,
					format,
					purpose: COMPOSE_PURPOSE,
					system,
					prompt,
					promptDigest: digest,
				},
				null,
				"\t",
			)}\n`,
		);
		ctx.work.finishTrial(trialId, {
			status: "interrupted",
			error: `missing recording; request written to requests/${fileName}`,
		});
		return base;
	}
	if (recording.promptDigest !== digest) {
		ctx.work.finishTrial(trialId, {
			status: "failed",
			error: `recording digest mismatch: prompt digest is ${digest}, recording claims ${recording.promptDigest}; recording refused`,
		});
		return { ...base, status: "digest-mismatch" };
	}

	const result = await ctx.inference.complete(request);
	ctx.work.recordModelCall(trialId, COMPOSE_PURPOSE, result);
	if (!result.ok) {
		ctx.work.finishTrial(trialId, { status: "failed", error: result.error });
		return { ...base, status: "inference-error" };
	}

	const parse = FORMAT_PARSERS[format](result.text);
	const authored = validateAuthoring(parse);
	const attempt: AttemptResults = { parse };
	if (authored?.status === "ready") {
		const check = checkDefinition(authored.definition, ctx.catalog.view);
		attempt.check = check;
		ctx.work.recordChecks(trialId, check.issues);
		if (check.ok) {
			const host = new MockHost({
				catalog: ctx.catalog.view,
				contracts: ctx.catalog.contracts,
				seed: ctx.seed,
				onCall: (call) => ctx.work.recordMockCall(ctx.runId, trialId, call),
			});
			attempt.run = await runPlan(check.plan, host, {
				runId: `${ctx.runId}:${evalCase.id}:${format}`,
				validateOutput: ctx.catalog.contracts.validate,
			});
		}
	}
	const score = scoreCase(evalCase, attempt, ctx.catalog.view);
	const passed = score.score.passed && authored !== null;
	const breakdown = {
		authoring: authored !== null,
		structure: score.score.structure,
		state: score.score.state,
		bundles: score.score.bundles,
		materials: score.score.materials,
		execution: score.score.execution,
		artifact: score.score.artifact,
		passed,
	};
	for (const [criterion, value] of Object.entries(breakdown))
		ctx.work.recordScore(trialId, {
			scorer: FORMAT_SCORER,
			criterion,
			value: value ? 1 : 0,
			...(criterion === "passed" ? { rationale: canonicalJson(score) } : {}),
		});
	ctx.work.finishTrial(trialId, {
		status: "completed",
		outputText: result.text,
	});
	return {
		...base,
		status: "scored",
		authoringOk: authored !== null,
		passed,
		score,
	};
}
