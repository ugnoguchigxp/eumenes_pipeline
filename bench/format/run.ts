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
 *
 * Repair (opt-in, `repair: true`): after the composing sweep, a cell that failed
 * MECHANICALLY — parse failure, authoring-contract failure, or `checkDefinition` errors —
 * gets exactly one repair call. The repair prompt carries only what the machine produced:
 * the original system + prompt, the model's original output, and the error locations and
 * messages of the parser / authoring schema / checker, verbatim. No gold, no case data,
 * no scores reach it (the builder below never sees the case's `expected`). Semantic
 * failures (state, bundles, materials, execution, artifact) are NOT repaired: they are
 * judgment, and feeding them back would teach to the gold. Repair traffic lives apart
 * from composing traffic — requests under `<session>/repair-requests/`, recordings under
 * `<session>/repair-recordings/`, keyed by the repair prompt's own digest, replayed
 * through the same recorded adapter, recorded in the work db as attempt 2 / phase
 * `repair`. A repaired output runs the same parse → authoring → check → mock → score
 * path; the summary records before/after verdicts and the repair calls' token cost.
 * A cell that stays failed after repair stays failed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDefinition, type CheckResult } from "../../src/check.ts";
import {
	authoringOutcome,
	type AuthoringOutcome,
} from "../../src/contracts/authoring.ts";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { CONTRACT_VERSION } from "../../src/contracts/record.ts";
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, type EvalCase } from "../cases/cases.ts";
import { FORMAT_PARSERS, FORMAT_IDS, type FormatId } from "../formats/index.ts";
import type { ParseResult } from "../formats/outcome.ts";
import {
	COMPOSE_PURPOSE,
	inferenceDigest,
	RecordedInference,
	REPAIR_PURPOSE,
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
	/** The one repair round of a mechanically failed cell; present only in repair runs. */
	repair?: FormatCellRepair;
};

/** The score aspects a repair round is compared on, before and after. */
export type RepairVerdict = {
	authoringOk: boolean;
	passed: boolean;
	state: boolean;
	bundles: boolean;
	materials: boolean;
};

export type FormatCellRepair = {
	status: FormatCellStatus;
	/** The composing attempt's verdict (mechanically failed by construction). */
	before: RepairVerdict;
	/** The repaired attempt's verdict; absent until a repair recording is scored. */
	after?: RepairVerdict;
	/** Tokens of the repair system + prompt; null if unavailable. */
	promptTokens: number | null;
	/** Tokens of the recorded repair output; null when there is none or no tokenizer. */
	outputTokens: number | null;
};

export type FormatRepairSummary = {
	/** Mechanically failed cells that were offered one repair call. */
	attempted: number;
	scored: number;
	missing: number;
	digestMismatch: number;
	inferenceErrors: number;
	/** Passed count over the attempted cells, before and after repair. */
	passedBefore: number;
	passedAfter: number;
	/** Total repair prompt tokens; null when any attempted cell could not be counted. */
	promptTokens: number | null;
	/** Total repair output tokens; null likewise. */
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
	/** Repair totals over the attempted cells; present only in repair runs. */
	repair?: FormatRepairSummary;
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

/**
 * The P0b contract gate: a parsed outcome still has to be a valid `AuthoringOutcome`.
 * On failure the schema's own issues are kept (path + message, verbatim) — they are the
 * machine errors a repair round may be shown.
 */
function parseAuthoring(parse: ParseResult): {
	outcome: AuthoringOutcome | null;
	issues: string[];
} {
	if (!parse.ok) return { outcome: null, issues: [] };
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
	if (parsed.success) return { outcome: parsed.data, issues: [] };
	return {
		outcome: null,
		issues: parsed.error.issues.map(
			(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
		),
	};
}

/** One evaluated attempt: everything the evaluator path produced for one output text. */
type EvaluatedAttempt = {
	parse: ParseResult;
	authored: AuthoringOutcome | null;
	/** Authoring-schema issues (path + message) when the contract gate failed. */
	authoringIssues: string[];
	check?: CheckResult;
	score: CaseScore;
	/** The attempt verdict: the scorer's `passed` gated by the authoring contract. */
	passed: boolean;
};

/**
 * The machine errors of an attempt, one line each, locations and messages verbatim from
 * the parser / authoring schema / checker — or null when the attempt did not fail
 * mechanically. Semantic failures return null: they are never repair material.
 */
function machineErrorLines(attempt: EvaluatedAttempt): string[] | null {
	if (!attempt.parse.ok)
		return attempt.parse.errors.map(
			(error) =>
				`[parse] ${error.code}: ${error.message}${error.position !== undefined ? ` (position ${error.position})` : ""}`,
		);
	if (!attempt.authored)
		return attempt.authoringIssues.map((issue) => `[schema] ${issue}`);
	if (attempt.authored.status === "ready" && attempt.check && !attempt.check.ok)
		return attempt.check.issues
			.filter((issue) => issue.severity === "error")
			.map(
				(issue) =>
					`[check] ${issue.code} at ${issue.path}: ${issue.message}${issue.candidates ? ` (candidates: ${issue.candidates.join(", ")})` : ""}`,
			);
	return null;
}

export const REPAIR_TEMPLATE_VERSION = "repair-prompt-v1";

const REPAIR_SYSTEM = `あなたは、手順定義の出力を機械検査にかけて返ってきたエラーを直す修復担当です。

進め方:
- 前回の出力と、機械検査が返したエラーの一覧が渡されます。
- 直すのは、そのエラーが解消するために必要な箇所だけです。手順の内容・部品の選択・依頼への答え方は変えず、文章の言い換えや手順の作り直しはしないでください。
- 出力は、元の出力と同じ形式の規則で、修正後の出力の全文だけにしてください。説明や前置きは付けないでください。`;

/**
 * The one repair prompt of a mechanically failed cell. Its whole content is the original
 * composing request (system + prompt, verbatim), the model's original output, and the
 * machine error lines — plus the framing above. It is built without the case's expected
 * values, which this module's caller never passes in.
 */
export function buildRepairPrompt(input: {
	system: string;
	prompt: string;
	output: string;
	errors: readonly string[];
}): { system: string; prompt: string } {
	return {
		system: REPAIR_SYSTEM,
		prompt: [
			"## 元の指示（system）",
			input.system,
			"",
			"## 元の依頼プロンプト",
			input.prompt,
			"",
			"## 前回の出力",
			input.output,
			"",
			"## 機械検査のエラー",
			...input.errors.map((line) => `- ${line}`),
			"",
			"上のエラーを解消するために必要な箇所だけを直した、前回の出力の全文を返してください。",
		].join("\n"),
	};
}

const verdictOf = (
	attempt: EvaluatedAttempt,
	authoringOk: boolean,
): RepairVerdict => ({
	authoringOk,
	passed: attempt.passed,
	state: attempt.score.score.state,
	bundles: attempt.score.score.bundles,
	materials: attempt.score.score.materials,
});

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
	/**
	 * One repair round for mechanically failed cells (see the module header). Off by
	 * default: a run without it is byte-for-byte the pre-repair bench — same prompts,
	 * same digests, same summary shape.
	 */
	repair?: boolean;
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
	const repairRequestsDir = join(sessionDir, "repair-requests");
	const repairRecordingsDir = join(sessionDir, "repair-recordings");
	if (options.repair) {
		mkdirSync(repairRequestsDir, { recursive: true });
		mkdirSync(repairRecordingsDir, { recursive: true });
	}

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
				outputStyle: condition.outputStyle,
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
			contractVersion: CONTRACT_VERSION,
			formats,
			promptTemplate: PROMPT_TEMPLATE_VERSION,
			cardsRendering: CARDS_RENDERING,
			cards: catalog.cards.length,
			policy: catalog.policy,
			seed,
			session: options.session,
			condition: conditionInfo,
			tokenizer: provenance,
			...(options.repair
				? { repair: true, repairTemplate: REPAIR_TEMPLATE_VERSION }
				: {}),
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
	const evaluations = new Map<string, EvaluatedAttempt>();
	const repairPromptTexts = new Map<string, string>();
	const repairOutputTexts = new Map<string, string>();
	const cellKey = (cell: { caseId: string; format: FormatId }) =>
		`${cell.caseId}\0${cell.format}`;
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
					evaluations,
				}),
			);
		}
		if (options.repair) {
			const repairRecordings =
				RecordedInference.fromDirectory(repairRecordingsDir);
			for (const [index, cell] of prepared.entries()) {
				await runRepair({
					cell,
					report: cells[index] as FormatCellReport,
					files: repairRecordings.files,
					inference: repairRecordings.inference,
					requestsDir: repairRequestsDir,
					catalog,
					work,
					runId,
					seed,
					outputs,
					evaluations,
					repairPromptTexts,
					repairOutputTexts,
					cellKey: cellKey({ caseId: cell.evalCase.id, format: cell.format }),
				});
			}
		}
		sweepDone = true;
	} finally {
		work.finishRun(runId, sweepDone ? "completed" : "failed");
		work.close();
		catalog.close();
	}

	// Count the recorded outputs in one batch and attach them to their cells.
	const withOutputs = cells.filter((cell) => outputs.has(cellKey(cell)));
	const outputCounts = countTokens(
		withOutputs.map((cell) => outputs.get(cellKey(cell)) as string),
	);
	withOutputs.forEach((cell, i) => {
		cell.outputTokens = outputCounts[i] ?? null;
	});

	// The repair calls' token cost, counted the same way (null where unavailable).
	const repairCells = cells.filter((cell) => cell.repair);
	const repairPromptCounts = countTokens(
		repairCells.map((cell) => repairPromptTexts.get(cellKey(cell)) as string),
	);
	repairCells.forEach((cell, i) => {
		if (cell.repair) cell.repair.promptTokens = repairPromptCounts[i] ?? null;
	});
	const repairScored = repairCells.filter(
		(cell) => cell.repair?.status === "scored",
	);
	const repairOutputCounts = countTokens(
		repairScored.map((cell) => repairOutputTexts.get(cellKey(cell)) as string),
	);
	repairScored.forEach((cell, i) => {
		if (cell.repair) cell.repair.outputTokens = repairOutputCounts[i] ?? null;
	});
	let repairSummary: FormatRepairSummary | undefined;
	if (options.repair) {
		const sumOrNull = (values: (number | null)[]) =>
			values.some((v) => v === null)
				? null
				: values.reduce<number>((a, v) => a + (v ?? 0), 0);
		repairSummary = {
			attempted: repairCells.length,
			scored: repairScored.length,
			missing: repairCells.filter((c) => c.repair?.status === "missing").length,
			digestMismatch: repairCells.filter(
				(c) => c.repair?.status === "digest-mismatch",
			).length,
			inferenceErrors: repairCells.filter(
				(c) => c.repair?.status === "inference-error",
			).length,
			passedBefore: repairCells.filter((c) => c.repair?.before.passed).length,
			passedAfter: repairCells.filter((c) => c.repair?.after?.passed).length,
			promptTokens: sumOrNull(
				repairCells.map((c) => c.repair?.promptTokens ?? null),
			),
			outputTokens:
				repairScored.length === 0
					? 0
					: sumOrNull(repairScored.map((c) => c.repair?.outputTokens ?? null)),
		};
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
		condition: conditionInfo,
		tokenizer: provenance,
		cells,
		byFormat,
		totals,
		...(repairSummary ? { repair: repairSummary } : {}),
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
				...(repairSummary ? { repair: repairSummary } : {}),
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
					...(cell.repair ? { repair: cell.repair } : {}),
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
	/** Evaluated composing attempts by the same key, kept for the repair phase. */
	evaluations: Map<string, EvaluatedAttempt>;
};

/**
 * The evaluator path of one output text — parse → authoring → check → mock → score —
 * shared by the composing attempt and its repair. Checks, mock calls and score rows are
 * recorded under the given trial; the caller owns the trial's lifecycle.
 */
async function evaluateAttempt(ctx: {
	evalCase: EvalCase;
	format: FormatId;
	catalog: ReturnType<typeof loadBenchCatalog>;
	work: ReturnType<typeof openWorkDb>;
	runId: string;
	seed: string;
	trialId: string;
	/** Mock run namespace: the composing attempt's, with `:repair` appended for repairs. */
	mockRunId: string;
	text: string;
}): Promise<EvaluatedAttempt> {
	const { evalCase, format } = ctx;
	const parse = FORMAT_PARSERS[format](ctx.text);
	const { outcome: authored, issues: authoringIssues } = parseAuthoring(parse);
	const attempt: AttemptResults = { parse };
	let check: CheckResult | undefined;
	if (authored?.status === "ready") {
		check = checkDefinition(authored.definition, ctx.catalog.view);
		attempt.check = check;
		ctx.work.recordChecks(ctx.trialId, check.issues);
		if (check.ok) {
			const host = new MockHost({
				catalog: ctx.catalog.view,
				contracts: ctx.catalog.contracts,
				seed: ctx.seed,
				onCall: (call) => ctx.work.recordMockCall(ctx.runId, ctx.trialId, call),
			});
			attempt.run = await runPlan(check.plan, host, {
				runId: ctx.mockRunId,
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
		ctx.work.recordScore(ctx.trialId, {
			scorer: FORMAT_SCORER,
			criterion,
			value: value ? 1 : 0,
			...(criterion === "passed" ? { rationale: canonicalJson(score) } : {}),
		});
	return {
		parse,
		authored,
		authoringIssues,
		...(check ? { check } : {}),
		score,
		passed,
	};
}

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

	const evaluated = await evaluateAttempt({
		evalCase,
		format,
		catalog: ctx.catalog,
		work: ctx.work,
		runId: ctx.runId,
		seed: ctx.seed,
		trialId,
		mockRunId: `${ctx.runId}:${evalCase.id}:${format}`,
		text: result.text,
	});
	ctx.evaluations.set(`${evalCase.id}\0${format}`, evaluated);
	ctx.work.finishTrial(trialId, {
		status: "completed",
		outputText: result.text,
	});
	return {
		...base,
		status: "scored",
		authoringOk: evaluated.authored !== null,
		passed: evaluated.passed,
		score: evaluated.score,
	};
}

type RepairContext = {
	/** The prepared composing cell (its system + prompt are the repair's raw material). */
	cell: {
		evalCase: EvalCase;
		format: FormatId;
		system: string;
		prompt: string;
	};
	/** The cell's report, mutated in place when the cell is repair-eligible. */
	report: FormatCellReport;
	files: Map<string, RecordingFile>;
	inference: RecordedInference;
	/** The session's `repair-requests/` directory. */
	requestsDir: string;
	catalog: ReturnType<typeof loadBenchCatalog>;
	work: ReturnType<typeof openWorkDb>;
	runId: string;
	seed: string;
	outputs: Map<string, string>;
	evaluations: Map<string, EvaluatedAttempt>;
	/** Repair prompt texts by cell key, for the run's token counting. */
	repairPromptTexts: Map<string, string>;
	repairOutputTexts: Map<string, string>;
	cellKey: string;
};

/**
 * The one repair round of one cell. A cell is eligible only when its composing attempt
 * was scored AND failed mechanically; anything else returns without touching the report.
 * The repair is recorded as its own trial (attempt 2, phase `repair`) and its output
 * runs the same evaluator path as a composing output.
 */
async function runRepair(ctx: RepairContext): Promise<void> {
	const { evalCase, format } = ctx.cell;
	const evaluated = ctx.evaluations.get(ctx.cellKey);
	const original = ctx.outputs.get(ctx.cellKey);
	if (!evaluated || original === undefined) return;
	const errors = machineErrorLines(evaluated);
	if (!errors) return;

	const built = buildRepairPrompt({
		system: ctx.cell.system,
		prompt: ctx.cell.prompt,
		output: original,
		errors,
	});
	const request = {
		purpose: REPAIR_PURPOSE,
		system: built.system,
		prompt: built.prompt,
	};
	const digest = inferenceDigest(request);
	const fileName = `${evalCase.id}--${format}.json`;
	const repair: FormatCellRepair = {
		status: "missing",
		before: verdictOf(evaluated, evaluated.authored !== null),
		promptTokens: null,
		outputTokens: null,
	};
	ctx.report.repair = repair;
	ctx.repairPromptTexts.set(ctx.cellKey, `${built.system}\n${built.prompt}`);
	const trialId = ctx.work.startTrial({
		runId: ctx.runId,
		caseId: evalCase.id,
		condition: format,
		attempt: 2,
		phase: "repair",
	});

	const recording = ctx.files.get(fileName);
	if (!recording) {
		writeFileSync(
			join(ctx.requestsDir, fileName),
			`${JSON.stringify(
				{
					caseId: evalCase.id,
					format,
					purpose: REPAIR_PURPOSE,
					system: built.system,
					prompt: built.prompt,
					promptDigest: digest,
				},
				null,
				"\t",
			)}\n`,
		);
		ctx.work.finishTrial(trialId, {
			status: "interrupted",
			error: `missing repair recording; request written to repair-requests/${fileName}`,
		});
		return;
	}
	if (recording.promptDigest !== digest) {
		ctx.work.finishTrial(trialId, {
			status: "failed",
			error: `repair recording digest mismatch: prompt digest is ${digest}, recording claims ${recording.promptDigest}; recording refused`,
		});
		repair.status = "digest-mismatch";
		return;
	}

	const result = await ctx.inference.complete(request);
	ctx.work.recordModelCall(trialId, REPAIR_PURPOSE, result);
	if (!result.ok) {
		ctx.work.finishTrial(trialId, { status: "failed", error: result.error });
		repair.status = "inference-error";
		return;
	}
	ctx.repairOutputTexts.set(ctx.cellKey, result.text);
	const after = await evaluateAttempt({
		evalCase,
		format,
		catalog: ctx.catalog,
		work: ctx.work,
		runId: ctx.runId,
		seed: ctx.seed,
		trialId,
		mockRunId: `${ctx.runId}:${evalCase.id}:${format}:repair`,
		text: result.text,
	});
	ctx.work.finishTrial(trialId, {
		status: "completed",
		outputText: result.text,
	});
	repair.status = "scored";
	repair.after = verdictOf(after, after.authored !== null);
}
