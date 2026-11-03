/**
 * bench:format — the format comparison runner (plan §10 P0c/P0d).
 *
 * One invocation = one work-db run over (case × format) cells under ONE prompt condition
 * (`conditions.ts`: which cards are offered, how they are rendered, whether the prompt
 * carries a worked example; the `baseline` condition is every offered card, full rendering,
 * no example). Inference is agent-model (`bench/infer/recorded.ts`): the runner never calls
 * a model. For each cell it builds the prompt, digests it, and looks for the recording the
 * generation step prepared; a cell without a recording gets a request file under
 * `<session>/requests/` and is counted as missing — never skipped silently, never filled in.
 * A recording whose digest does not match the current prompt is refused, not used.
 * Prompts and outputs are also counted with the target model family's tokenizer
 * (`bench/tokens.ts`); where no tokenizer is available the counts stay null.
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
import type { ComponentCard } from "../../src/contracts/component.ts";
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
import { countTokens, tokenizerProvenance } from "../tokens.ts";
import type { TokenizerProvenance } from "../tokens.ts";
import {
	BASELINE_CONDITION,
	summarizeCondition,
	WORKED_EXAMPLES,
	type ConditionSummary,
	type FormatCondition,
} from "./conditions.ts";
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
	/** Tokens of system + prompt under the target family's tokenizer; null if unavailable. */
	promptTokens: number | null;
	/** Tokens of the recorded output; null when there is no output or no tokenizer. */
	outputTokens: number | null;
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
	/** The prompt condition the whole run was executed under. */
	condition: ConditionSummary;
	/** Where the run's token counts came from (never a model name baked into code). */
	tokenizer: TokenizerProvenance;
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
	/** Prompt condition of the run (default: the registry's `baseline`). */
	condition?: FormatCondition;
	/**
	 * Per-case offered-entry subsets (Router or oracle candidates): a case listed here is
	 * offered exactly the named entries; a case not listed falls back to the condition's
	 * card set. Entry ids and case ids are validated before the run starts.
	 */
	candidates?: Readonly<Record<string, readonly string[]>>;
};

/** The cards one cell offers, in catalog order, under the condition and any candidates. */
function selectCards(
	condition: FormatCondition,
	candidates: FormatRunOptions["candidates"],
	evalCase: EvalCase,
	all: readonly ComponentCard[],
): readonly ComponentCard[] {
	const entries =
		candidates && Object.hasOwn(candidates, evalCase.id)
			? candidates[evalCase.id]
			: condition.cardSet === "all"
				? null
				: condition.cardSet.entries;
	if (!entries) return all;
	const wanted = new Set(entries);
	return all.filter((card) => wanted.has(card.entry));
}

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
	const condition = options.condition ?? BASELINE_CONDITION;

	// Validate the condition and the candidates BEFORE the run starts: an entry id that is
	// not offered, or a candidates key that is not a case, is a bench setup error and must
	// fail loudly here — never shrink a cell's cards or a run's cases silently.
	const offeredEntries = new Set(catalog.cards.map((c) => c.entry));
	const unknownEntries = new Set<string>();
	const checkEntries = (entries: readonly string[]) => {
		for (const entry of entries)
			if (!offeredEntries.has(entry)) unknownEntries.add(entry);
	};
	if (condition.cardSet !== "all") checkEntries(condition.cardSet.entries);
	if (options.candidates)
		for (const [caseId, entries] of Object.entries(options.candidates)) {
			if (!allCases.some((c) => c.id === caseId))
				throw new Error(`candidates name an unknown case id: ${caseId}`);
			checkEntries(entries);
		}
	if (unknownEntries.size > 0)
		throw new Error(
			`condition/candidates name entries that are not offered: ${[...unknownEntries].sort().join(", ")}`,
		);
	const conditionInfo = summarizeCondition(
		condition,
		options.candidates !== undefined,
	);
	const provenance = tokenizerProvenance();

	// Build every prompt up front and count them in one batch: the prompt of a cell does
	// not depend on its recording, and one helper call keeps the counting cheap.
	type PreparedCell = {
		evalCase: EvalCase;
		format: FormatId;
		system: string;
		prompt: string;
		promptTokens: number | null;
	};
	const prepared: PreparedCell[] = [];
	for (const evalCase of cases)
		for (const format of formats) {
			const built = buildFormatPrompt({
				evalCase,
				format,
				cards: selectCards(
					condition,
					options.candidates,
					evalCase,
					catalog.cards,
				),
				cardStyle: condition.cardStyle,
				...(condition.shots === 1
					? { workedExample: WORKED_EXAMPLES[format] }
					: {}),
			});
			prepared.push({ evalCase, format, ...built, promptTokens: null });
		}
	const promptCounts = countTokens(
		prepared.map((cell) => `${cell.system}\n${cell.prompt}`),
	);
	prepared.forEach((cell, i) => {
		cell.promptTokens = promptCounts[i] ?? null;
	});

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
			condition: conditionInfo,
			tokenizer: provenance,
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
	const outputs = new Map<string, string>();
	let sweepDone = false;
	try {
		const { inference, files } = RecordedInference.fromDirectory(recordingsDir);
		for (const cell of prepared) {
			cells.push(
				await runCell({
					...cell,
					files,
					inference,
					requestsDir,
					catalog,
					work,
					runId,
					seed,
					outputs,
				}),
			);
		}
		sweepDone = true;
	} finally {
		work.finishRun(runId, sweepDone ? "completed" : "failed");
		work.close();
		catalog.close();
	}

	// Count the recorded outputs in one batch and attach them to their cells.
	const cellKey = (cell: FormatCellReport) => `${cell.caseId}\0${cell.format}`;
	const withOutputs = cells.filter((cell) => outputs.has(cellKey(cell)));
	const outputCounts = countTokens(
		withOutputs.map((cell) => outputs.get(cellKey(cell)) as string),
	);
	withOutputs.forEach((cell, i) => {
		cell.outputTokens = outputCounts[i] ?? null;
	});

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
		condition: conditionInfo,
		tokenizer: provenance,
		cells,
		byFormat,
		totals,
	};
	writeFileSync(
		join(sessionDir, "summary.json"),
		`${JSON.stringify(
			{
				runId,
				condition: conditionInfo,
				tokenizer: provenance,
				byFormat,
				totals,
				cells: cells.map((cell) => ({
					caseId: cell.caseId,
					format: cell.format,
					fixtureDependent: cell.fixtureDependent,
					status: cell.status,
					...(cell.authoringOk !== undefined
						? { authoringOk: cell.authoringOk }
						: {}),
					...(cell.passed !== undefined ? { passed: cell.passed } : {}),
					promptTokens: cell.promptTokens,
					outputTokens: cell.outputTokens,
				})),
			},
			null,
			"\t",
		)}\n`,
	);
	return report;
}

type CellContext = {
	evalCase: EvalCase;
	format: FormatId;
	/** The cell's prompt, built once by the run under its condition. */
	system: string;
	prompt: string;
	promptTokens: number | null;
	files: Map<string, RecordingFile>;
	inference: RecordedInference;
	requestsDir: string;
	catalog: ReturnType<typeof loadBenchCatalog>;
	work: ReturnType<typeof openWorkDb>;
	runId: string;
	seed: string;
	/** Recorded outputs by `${caseId}\0${format}`, for the run's output token counting. */
	outputs: Map<string, string>;
};

async function runCell(ctx: CellContext): Promise<FormatCellReport> {
	const { evalCase, format } = ctx;
	const base: FormatCellReport = {
		caseId: evalCase.id,
		format,
		fixtureDependent: evalCase.usesFixtureContracts,
		status: "missing",
		promptTokens: ctx.promptTokens,
		outputTokens: null,
	};
	const { system, prompt } = ctx;
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
	ctx.outputs.set(`${evalCase.id}\0${format}`, result.text);

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
