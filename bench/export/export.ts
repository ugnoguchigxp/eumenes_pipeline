/**
 * Run export (plan §10 P3): one work-db run rewritten as a single self-describing JSON
 * document a third party can verify without opening the database.
 *
 * The export joins three sources, all read-only:
 * - the work db (runs / trials / model_calls / checks / scores — the append-only record);
 * - the case files (gold provenance: each case's split, group, expected kind and fixture
 *   flag, plus the SHA-256 of the case file itself, so the gold a score was computed
 *   against can be pinned byte-for-byte);
 * - the session's `summary.json` (the only place per-cell token counts live: the recorded
 *   inference adapter reports no usage, so tokens exist solely as the runner's tokenizer
 *   counts recorded in the summary).
 *
 * Totals are RECOMPUTED from the db's score rows, never copied from the summary; when the
 * session summary belongs to the exported run, the export cross-checks the recomputation
 * against it (totals, per-cell status / verdicts / token counts, repair verdicts) and
 * reports every difference. A summary left behind by a later re-run of the same session is
 * reported as superseded, not as an inconsistency. Values the sources do not hold stay
 * null — never 0, never estimated (plan §10).
 *
 * Contract-version recording starts with P3: older runs carry the catalog version and
 * the snapshot / contracts / fixtures digests in their inputs, but no contract version
 * in their config. The export reports the recorded `contractVersion` when the run has
 * one (null for the older runs — never back-filled) and, separately, the exporting code's
 * `CONTRACT_VERSION`, labelled as export-time.
 *
 * Saved form of definitions (user decision, 2026-11-04): generation may be minified to
 * save tokens, but a definition is SAVED in pretty-printed JSON. The export is the
 * bench's saved artifact, so each cell that authored a valid definition carries it here
 * as structured data — the CLI writes this document with indentation, which makes the
 * saved form pretty regardless of how compact the model's raw output was (and whatever
 * wire format it used). The raw outputs themselves stay untouched in the work db and
 * the session recordings: they are evidence, not the saved form. The same rule binds
 * the host at integration time (the persisted `DocumentRecord` is pretty JSON).
 *
 * Syntax restore (opt-in runner stage): a restore run records a `syntax_restored`
 * criterion per trial and `restoreSyntax` / `restoreEngine` in its config. The export
 * surfaces both as per-cell flags (null for runs that recorded no criterion) and as
 * recomputed run totals, cross-checked against the summary's `restore` block when it
 * belongs to the run. A restored cell's saved definition is re-derived through the
 * same restore the runner applied, so the export shows the definition the runner
 * actually scored — the raw output in the db stays untouched either way.
 *
 * Step-id normalization (opt-in runner stage) is surfaced the same way: an
 * `ids_normalized` criterion per trial and `normalizeIds` / `normalizeVersion` in
 * the config become per-cell flags and recomputed totals (the recompute re-runs
 * the deterministic gate over the recorded outputs), cross-checked against the
 * summary's `normalize` block. A normalized cell's saved definition is re-derived
 * through the same gate, so it shows the rewritten ids the runner scored.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineDefinition } from "../../src/contracts/definition.ts";
import { CONTRACT_VERSION } from "../../src/contracts/record.ts";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import { DEFAULT_CASES_DIR, loadCases } from "../cases/cases.ts";
import type { ConditionSummary } from "../format/conditions.ts";
import { FORMAT_PARSERS, type FormatId } from "../formats/index.ts";
import { validateAuthoring } from "../formats/normalize-ids.ts";
import { captureCases, readCaseSnapshot } from "../cases/provenance.ts";
import type { ParseResult } from "../formats/outcome.ts";
import { parseJsonWithRestore } from "../formats/restore.ts";
import {
	DEFAULT_RUNS_ROOT,
	type FormatGroupSummary,
	type FormatNormalizeSummary,
	type FormatRepairSummary,
	type FormatRestoreSummary,
	type RepairVerdict,
} from "../format/run.ts";
import type { CaseScore } from "../scoring/score.ts";
import { DEFAULT_WORK_DB } from "../store/work-db.ts";

export const EXPORT_VERSION = 1;
export const DEFAULT_EXPORTS_DIR = "data/runs/exports";

export type ExportCellStatus =
	"scored" | "missing" | "digest-mismatch" | "inference-error" | "incomplete";

export type ExportCase = {
	id: string;
	split: "dev" | "holdout";
	group: string | null;
	expectedKind: "pipeline" | "needs_input" | "unsupported";
	usesFixtureContracts: boolean;
	/** The evaluator-only file the gold lives in; its digest pins the gold bytes. */
	goldSource: string;
	goldSha256: string;
};

export type ExportCell = {
	caseId: string;
	format: string;
	trialId: string;
	status: ExportCellStatus;
	/** Whether the attempt satisfied the `AuthoringOutcome` contract; null unless scored. */
	authoringOk: boolean | null;
	/** The cell verdict (scorer's `passed` gated by the authoring contract). */
	passed: boolean | null;
	/** The full deterministic score record, recovered from the score row's rationale. */
	score: CaseScore | null;
	/** The recorded criterion values (0/1) exactly as stored in the work db. */
	criteria: Record<string, number | null>;
	checks: { code: string; path: string; severity: string; message: string }[];
	/** The recorded inference's model name (`agent-model` for recorded replay). */
	model: string | null;
	/**
	 * The authored definition in its saved form, when the cell's output parsed and
	 * satisfied the `AuthoringOutcome` contract as `ready`; null otherwise (the raw
	 * output remains in the work db). Serialized by the CLI as pretty-printed JSON
	 * even when the model wrote minified output (see the module header).
	 */
	definition: PipelineDefinition | null;
	/**
	 * The composing attempt's parse was recovered by the syntax-restore stage;
	 * null when the run recorded no `syntax_restored` criterion (non-restore runs).
	 */
	syntaxRestored: boolean | null;
	/**
	 * The composing attempt's authoring gate was recovered by step-id normalization;
	 * null when the run recorded no `ids_normalized` criterion (non-normalization runs).
	 */
	idsNormalized: boolean | null;
	outputDigest: string | null;
	error: string | null;
	/** Tokenizer counts from the session summary; null when no matching summary exists. */
	promptTokens: number | null;
	outputTokens: number | null;
	repair?: ExportRepair;
};

export type ExportRepair = {
	status: ExportCellStatus;
	trialId: string;
	before: RepairVerdict;
	after: RepairVerdict | null;
	/** The repaired definition in its saved form, under the same rule as cells. */
	definition: PipelineDefinition | null;
	/** The repair attempt's parse was recovered by syntax restore; null as on cells. */
	syntaxRestored: boolean | null;
	/** The repair attempt's authoring gate was recovered by step-id normalization; null as on cells. */
	idsNormalized: boolean | null;
	promptTokens: number | null;
	outputTokens: number | null;
};

export type SummaryCrossCheck = {
	session: string | null;
	summaryFound: boolean;
	summaryRunId: string | null;
	/** The session summary on disk belongs to the exported run. */
	runMatches: boolean;
	/** Recomputed totals vs the summary's, when comparable (else null). */
	totalsEqual: boolean | null;
	cellsEqual: boolean | null;
	repairEqual: boolean | null;
	restoreEqual: boolean | null;
	normalizeEqual: boolean | null;
	differences: string[];
};

export type RunExport = {
	exportVersion: number;
	exportedAt: string;
	run: {
		runId: string;
		kind: string;
		parentRunId: string | null;
		status: string;
		createdAt: string;
		finishedAt: string | null;
		note: string | null;
		configDigest: string;
	};
	/** The run's recorded config, verbatim (condition, formats, templates, tokenizer…). */
	config: Record<string, unknown>;
	/** The run's recorded inputs, verbatim (snapshot / contracts / fixtures digests…). */
	inputs: Record<string, unknown>;
	provenance: {
		catalogVersion: string | null;
		snapshotSha256: string | null;
		contractsSha256: string | null;
		fixturesSha256: string | null;
		/** The contract version the run itself recorded (P3 onward); null for older runs. */
		contractVersion: string | null;
		/** The definition contract version of the code performing this export. */
		contractVersionAtExport: string;
		casesPinned: boolean;
		caseSetSha256: string | null;
	};
	condition: ConditionSummary | null;
	cases: ExportCase[];
	cells: ExportCell[];
	byFormat: Record<
		string,
		{
			catalogOnly: FormatGroupSummary;
			fixtureDependent: FormatGroupSummary;
			total: FormatGroupSummary;
		}
	>;
	totals: FormatGroupSummary;
	repair?: FormatRepairSummary;
	/** Syntax-restore totals recomputed from the trials' criteria; restore runs only. */
	restore?: FormatRestoreSummary;
	/** Step-id normalization totals recomputed by re-running the gate; normalization runs only. */
	normalize?: FormatNormalizeSummary;
	summaryCrossCheck: SummaryCrossCheck;
};

type TrialRow = {
	trial_id: string;
	case_id: string;
	condition: string;
	attempt: number;
	phase: string;
	status: string;
	output_text: string | null;
	output_digest: string | null;
	error: string | null;
};

/**
 * The parse of a trial's recorded output, re-derived the way the runner derived it.
 * When the trial's parse was recovered by syntax restore (`restored`), the derivation
 * goes through the same restore, mirroring the runner; the raw text is never altered.
 */
function deriveParse(
	format: string,
	outputText: string | null,
	restored = false,
): ParseResult | null {
	if (!outputText || !(format in FORMAT_PARSERS)) return null;
	return restored && format === "json"
		? parseJsonWithRestore(outputText).result
		: FORMAT_PARSERS[format as FormatId](outputText);
}

/**
 * The definition a trial authored, in its saved form: re-derive it exactly the way the
 * runner did (format parser → `AuthoringOutcome` contract) and keep it only when the
 * outcome is a valid `ready`. Anything else — unparseable, needs_input, unsupported,
 * contract violation — has no saved definition (null), however suggestive the raw text.
 * When the trial's authoring gate was recovered by step-id normalization
 * (`idsNormalized`), the derivation runs the same gate with the stage on, so the
 * saved form carries the rewritten ids the runner scored.
 */
function savedDefinition(
	format: string,
	outputText: string | null,
	restored = false,
	idsNormalized = false,
): PipelineDefinition | null {
	const parse = deriveParse(format, outputText, restored);
	if (!parse) return null;
	const gate = validateAuthoring(parse, { normalizeIds: idsNormalized });
	return gate.outcome?.status === "ready" ? gate.outcome.definition : null;
}

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

/** The same accumulation as the format runner's summary, fed from db-recovered cells. */
function addCell(group: FormatGroupSummary, cell: ExportCell): void {
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

/** A trial's cell status, derived the way the runner assigned it. */
function cellStatus(trial: TrialRow): ExportCellStatus {
	if (trial.status === "completed") return "scored";
	if (trial.status === "interrupted") return "missing";
	if (trial.status === "failed")
		return trial.error?.includes("digest mismatch")
			? "digest-mismatch"
			: "inference-error";
	return "incomplete";
}

function verdictOf(
	score: CaseScore | null,
	authoringOk: boolean | null,
	/** The gated cell verdict (scorer's `passed` AND the authoring contract). */
	passed: boolean | null,
): RepairVerdict {
	return {
		authoringOk: authoringOk ?? false,
		passed: passed ?? false,
		state: score?.score.state ?? false,
		bundles: score?.score.bundles ?? false,
		materials: score?.score.materials ?? false,
	};
}

type SummaryCell = {
	caseId: string;
	format: string;
	status: string;
	authoringOk?: boolean;
	passed?: boolean;
	syntaxRestored?: boolean;
	idsNormalized?: boolean;
	promptTokens: number | null;
	outputTokens: number | null;
	repair?: {
		status: string;
		before: RepairVerdict;
		after?: RepairVerdict;
		syntaxRestored?: boolean;
		idsNormalized?: boolean;
		promptTokens: number | null;
		outputTokens: number | null;
	};
};

type SessionSummary = {
	runId: string;
	condition: ConditionSummary;
	byFormat: RunExport["byFormat"];
	totals: FormatGroupSummary;
	repair?: FormatRepairSummary;
	restore?: FormatRestoreSummary;
	normalize?: FormatNormalizeSummary;
	cells: SummaryCell[];
};

export function buildRunExport(options: {
	runId: string;
	dbPath?: string;
	casesDir?: string;
	runsRoot?: string;
}): RunExport {
	const dbPath = options.dbPath ?? DEFAULT_WORK_DB;
	const casesDir = options.casesDir ?? DEFAULT_CASES_DIR;
	const runsRoot = options.runsRoot ?? DEFAULT_RUNS_ROOT;
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const run = db
			.query<
				{
					run_id: string;
					kind: string;
					parent_run_id: string | null;
					created_at: string;
					status: string;
					finished_at: string | null;
					note: string | null;
					config_json: string;
					config_digest: string;
					inputs_json: string;
				},
				[string]
			>(
				"SELECT run_id, kind, parent_run_id, created_at, status, finished_at, note, config_json, config_digest, inputs_json FROM runs WHERE run_id = ?",
			)
			.get(options.runId);
		if (!run) throw new Error(`export: no run ${options.runId} in ${dbPath}`);
		const config = JSON.parse(run.config_json) as Record<string, unknown>;
		const inputs = JSON.parse(run.inputs_json) as Record<string, unknown>;
		const caseIds = Array.isArray(inputs.caseIds)
			? inputs.caseIds.filter((v): v is string => typeof v === "string")
			: [];

		// Gold provenance: the case files, digested byte-for-byte.
		const pinned =
			inputs.caseSnapshot === undefined
				? null
				: readCaseSnapshot(inputs.caseSnapshot);
		const allCases = pinned?.cases ?? loadCases(casesDir);
		if (pinned && options.casesDir) {
			const supplied = loadCases(casesDir).filter((c) =>
				caseIds.includes(c.id),
			);
			const observed = captureCases(supplied, casesDir);
			if (observed.digest !== pinned.snapshot.digest)
				throw new Error(
					"export: case snapshot drift; use the run's pinned cases",
				);
		}
		const caseById = new Map(allCases.map((c) => [c.id, c]));
		const cases: ExportCase[] = caseIds.map((id) => {
			const found = caseById.get(id);
			if (!found) throw new Error(`export: run names unknown case "${id}"`);
			const raw = pinned
				? pinned.snapshot.files.find((f) => f.id === id)?.content
				: readFileSync(join(casesDir, `${id}.json`), "utf8");
			if (raw === undefined)
				throw new Error(`export: pinned case missing: ${id}`);
			return {
				id,
				split: found.split,
				group: found.group ?? null,
				expectedKind: found.expected.kind,
				usesFixtureContracts: found.usesFixtureContracts,
				goldSource: pinned
					? `run:${run.run_id}/cases/${id}.json`
					: `${casesDir}/${id}.json`,
				goldSha256: sha256(raw),
			};
		});
		const fixtureByCase = new Map(
			cases.map((c) => [c.id, c.usesFixtureContracts]),
		);

		// Trials and their recorded detail.
		const trials = db
			.query<TrialRow, [string]>(
				"SELECT trial_id, case_id, condition, attempt, phase, status, output_text, output_digest, error FROM trials WHERE run_id = ? ORDER BY case_id, condition, attempt",
			)
			.all(options.runId);
		const scoresOf = (trialId: string) =>
			db
				.query<
					{ criterion: string; value: number | null; rationale: string | null },
					[string]
				>(
					"SELECT criterion, value, rationale FROM scores WHERE trial_id = ? ORDER BY criterion",
				)
				.all(trialId);
		const detailOf = (trial: TrialRow) => {
			const criteria: Record<string, number | null> = {};
			let score: CaseScore | null = null;
			for (const row of scoresOf(trial.trial_id)) {
				criteria[row.criterion] = row.value;
				if (row.criterion === "passed" && row.rationale)
					score = JSON.parse(row.rationale) as CaseScore;
			}
			const checks = db
				.query<
					{ code: string; path: string; severity: string; message: string },
					[string]
				>(
					"SELECT code, path, severity, message FROM checks WHERE trial_id = ? ORDER BY id",
				)
				.all(trial.trial_id);
			const modelCall = db
				.query<{ model: string | null }, [string]>(
					"SELECT model FROM model_calls WHERE trial_id = ? ORDER BY id LIMIT 1",
				)
				.get(trial.trial_id);
			return { criteria, score, checks, model: modelCall?.model ?? null };
		};

		const composeTrials = trials.filter(
			(t) => t.phase === "compose" && t.attempt === 1,
		);
		const repairTrials = new Map<string, TrialRow>();
		for (const t of trials)
			if (t.phase === "repair")
				repairTrials.set(`${t.case_id}\0${t.condition}`, t);

		// Syntax restore: the run's config says whether the stage was on; each trial's
		// `syntax_restored` criterion says whether it recovered that trial's parse
		// (absent criterion → null: the run recorded nothing about restore).
		const restoreRun = config.restoreSyntax === true;
		const restoredOf = (
			criteria: Record<string, number | null>,
		): boolean | null =>
			"syntax_restored" in criteria ? criteria.syntax_restored === 1 : null;

		// Step-id normalization, likewise: config flag + the `ids_normalized` criterion.
		const normalizeRun = config.normalizeIds === true;
		const normalizedOf = (
			criteria: Record<string, number | null>,
		): boolean | null =>
			"ids_normalized" in criteria ? criteria.ids_normalized === 1 : null;

		const cells: ExportCell[] = composeTrials.map((trial) => {
			const { criteria, score, checks, model } = detailOf(trial);
			const status = cellStatus(trial);
			const scored = status === "scored";
			const syntaxRestored = scored ? restoredOf(criteria) : null;
			const idsNormalized = scored ? normalizedOf(criteria) : null;
			return {
				caseId: trial.case_id,
				format: trial.condition,
				trialId: trial.trial_id,
				status,
				authoringOk: scored ? criteria.authoring === 1 : null,
				passed: scored ? criteria.passed === 1 : null,
				score,
				criteria,
				checks,
				model,
				definition: scored
					? savedDefinition(
							trial.condition,
							trial.output_text,
							syntaxRestored === true,
							idsNormalized === true,
						)
					: null,
				syntaxRestored,
				idsNormalized,
				outputDigest: trial.output_digest,
				error: trial.error,
				promptTokens: null,
				outputTokens: null,
			};
		});

		// Repair attempts, rebuilt from their own trials (verdicts), not from the summary.
		const repairByCell = new Map<string, ExportRepair>();
		for (const cell of cells) {
			const key = `${cell.caseId}\0${cell.format}`;
			const trial = repairTrials.get(key);
			if (!trial) continue;
			const { criteria, score } = detailOf(trial);
			const status = cellStatus(trial);
			const syntaxRestored = status === "scored" ? restoredOf(criteria) : null;
			const idsNormalized = status === "scored" ? normalizedOf(criteria) : null;
			repairByCell.set(key, {
				status,
				trialId: trial.trial_id,
				before: verdictOf(cell.score, cell.authoringOk, cell.passed),
				after:
					status === "scored"
						? verdictOf(score, criteria.authoring === 1, criteria.passed === 1)
						: null,
				definition:
					status === "scored"
						? savedDefinition(
								trial.condition,
								trial.output_text,
								syntaxRestored === true,
								idsNormalized === true,
							)
						: null,
				syntaxRestored,
				idsNormalized,
				promptTokens: null,
				outputTokens: null,
			});
		}
		for (const cell of cells) {
			const repair = repairByCell.get(`${cell.caseId}\0${cell.format}`);
			if (repair) cell.repair = repair;
		}

		// Totals recomputed from the db alone.
		const byFormat: RunExport["byFormat"] = {};
		for (const cell of cells) {
			const group = (byFormat[cell.format] ??= {
				catalogOnly: emptyGroup(),
				fixtureDependent: emptyGroup(),
				total: emptyGroup(),
			});
			addCell(
				fixtureByCase.get(cell.caseId)
					? group.fixtureDependent
					: group.catalogOnly,
				cell,
			);
			addCell(group.total, cell);
		}
		const totals = emptyGroup();
		for (const cell of cells) addCell(totals, cell);

		// Restore totals recomputed from the criteria: a composing cell was offered
		// restore exactly when its recorded parse (post-restore) failed or its parse
		// was recovered by restore — the raw parse rate stays separable either way.
		let restoreSummary: FormatRestoreSummary | undefined;
		if (restoreRun) {
			const offered = cells.filter(
				(cell) =>
					cell.format === "json" &&
					cell.syntaxRestored !== null &&
					(cell.syntaxRestored || cell.score?.parseOk === false),
			);
			restoreSummary = {
				attempted: offered.length,
				recovered: offered.filter((cell) => cell.syntaxRestored).length,
			};
		}

		// Normalization totals recomputed exactly: the gate is deterministic, so
		// re-running it over each scored composing trial's recorded output (through
		// the same restore the runner applied, when it did) reproduces the runner's
		// attempted / recovered counts without trusting the summary.
		let normalizeSummary: FormatNormalizeSummary | undefined;
		if (normalizeRun) {
			let attempted = 0;
			let recovered = 0;
			for (const trial of composeTrials) {
				if (cellStatus(trial) !== "scored") continue;
				const { criteria } = detailOf(trial);
				const parse = deriveParse(
					trial.condition,
					trial.output_text,
					restoredOf(criteria) === true,
				);
				if (!parse) continue;
				const gate = validateAuthoring(parse, { normalizeIds: true });
				if (gate.normalizeAttempted) attempted += 1;
				if (gate.idsNormalized) recovered += 1;
			}
			normalizeSummary = { attempted, recovered };
		}

		// The session summary: token source and cross-check target, when it is this run's.
		const session = typeof config.session === "string" ? config.session : null;
		const cross: SummaryCrossCheck = {
			session,
			summaryFound: false,
			summaryRunId: null,
			runMatches: false,
			totalsEqual: null,
			cellsEqual: null,
			repairEqual: null,
			restoreEqual: null,
			normalizeEqual: null,
			differences: [],
		};
		let repairSummary: FormatRepairSummary | undefined;
		const summaryPath = session
			? join(runsRoot, session, "summary.json")
			: null;
		if (summaryPath && existsSync(summaryPath)) {
			const summary = JSON.parse(
				readFileSync(summaryPath, "utf8"),
			) as SessionSummary;
			cross.summaryFound = true;
			cross.summaryRunId = summary.runId;
			cross.runMatches = summary.runId === options.runId;
			if (cross.runMatches) {
				let cellDiffs = 0;
				let repairDiffs = 0;
				const summaryCell = new Map(
					summary.cells.map((c) => [`${c.caseId}\0${c.format}`, c]),
				);
				for (const cell of cells) {
					const s = summaryCell.get(`${cell.caseId}\0${cell.format}`);
					if (!s) {
						cellDiffs += 1;
						cross.differences.push(
							`cell ${cell.caseId}/${cell.format}: in db, not in summary`,
						);
						continue;
					}
					cell.promptTokens = s.promptTokens;
					cell.outputTokens = s.outputTokens;
					if (s.status !== cell.status) {
						cellDiffs += 1;
						cross.differences.push(
							`cell ${cell.caseId}/${cell.format}: status summary=${s.status} db=${cell.status}`,
						);
					}
					if ((s.authoringOk ?? null) !== cell.authoringOk) {
						cellDiffs += 1;
						cross.differences.push(
							`cell ${cell.caseId}/${cell.format}: authoringOk summary=${s.authoringOk ?? null} db=${cell.authoringOk}`,
						);
					}
					if ((s.passed ?? null) !== cell.passed) {
						cellDiffs += 1;
						cross.differences.push(
							`cell ${cell.caseId}/${cell.format}: passed summary=${s.passed ?? null} db=${cell.passed}`,
						);
					}
					if ((s.syntaxRestored ?? null) !== cell.syntaxRestored) {
						cellDiffs += 1;
						cross.differences.push(
							`cell ${cell.caseId}/${cell.format}: syntaxRestored summary=${s.syntaxRestored ?? null} db=${cell.syntaxRestored}`,
						);
					}
					if ((s.idsNormalized ?? null) !== cell.idsNormalized) {
						cellDiffs += 1;
						cross.differences.push(
							`cell ${cell.caseId}/${cell.format}: idsNormalized summary=${s.idsNormalized ?? null} db=${cell.idsNormalized}`,
						);
					}
					if (s.repair || cell.repair) {
						if (!s.repair || !cell.repair) {
							repairDiffs += 1;
							cross.differences.push(
								`cell ${cell.caseId}/${cell.format}: repair present on one side only`,
							);
						} else {
							cell.repair.promptTokens = s.repair.promptTokens;
							cell.repair.outputTokens = s.repair.outputTokens;
							if (s.repair.status !== cell.repair.status) {
								repairDiffs += 1;
								cross.differences.push(
									`cell ${cell.caseId}/${cell.format}: repair status summary=${s.repair.status} db=${cell.repair.status}`,
								);
							}
							if (
								canonicalJson(s.repair.before) !==
								canonicalJson(cell.repair.before)
							) {
								repairDiffs += 1;
								cross.differences.push(
									`cell ${cell.caseId}/${cell.format}: repair before-verdict differs`,
								);
							}
							if (
								canonicalJson(s.repair.after ?? null) !==
								canonicalJson(cell.repair.after)
							) {
								repairDiffs += 1;
								cross.differences.push(
									`cell ${cell.caseId}/${cell.format}: repair after-verdict differs`,
								);
							}
							if (
								(s.repair.syntaxRestored ?? null) !== cell.repair.syntaxRestored
							) {
								repairDiffs += 1;
								cross.differences.push(
									`cell ${cell.caseId}/${cell.format}: repair syntaxRestored summary=${s.repair.syntaxRestored ?? null} db=${cell.repair.syntaxRestored}`,
								);
							}
							if (
								(s.repair.idsNormalized ?? null) !== cell.repair.idsNormalized
							) {
								repairDiffs += 1;
								cross.differences.push(
									`cell ${cell.caseId}/${cell.format}: repair idsNormalized summary=${s.repair.idsNormalized ?? null} db=${cell.repair.idsNormalized}`,
								);
							}
						}
					}
				}
				if (summary.cells.length !== cells.length) {
					cellDiffs += 1;
					cross.differences.push(
						`cell count summary=${summary.cells.length} db=${cells.length}`,
					);
				}
				cross.totalsEqual =
					canonicalJson(summary.totals) === canonicalJson(totals) &&
					canonicalJson(summary.byFormat) === canonicalJson(byFormat);
				if (!cross.totalsEqual)
					cross.differences.push("totals/byFormat differ from the summary");
				cross.cellsEqual = cellDiffs === 0;
				cross.repairEqual = repairDiffs === 0;
				if (summary.repair) {
					// Token totals exist only in the summary; verdict counts are recomputed.
					const attempted = cells.filter((c) => c.repair);
					const recomputed: FormatRepairSummary = {
						attempted: attempted.length,
						scored: attempted.filter((c) => c.repair?.status === "scored")
							.length,
						missing: attempted.filter((c) => c.repair?.status === "missing")
							.length,
						digestMismatch: attempted.filter(
							(c) => c.repair?.status === "digest-mismatch",
						).length,
						inferenceErrors: attempted.filter(
							(c) => c.repair?.status === "inference-error",
						).length,
						passedBefore: attempted.filter((c) => c.repair?.before.passed)
							.length,
						passedAfter: attempted.filter((c) => c.repair?.after?.passed)
							.length,
						promptTokens: summary.repair.promptTokens,
						outputTokens: summary.repair.outputTokens,
					};
					if (canonicalJson(recomputed) !== canonicalJson(summary.repair)) {
						cross.repairEqual = false;
						cross.differences.push("repair totals differ from the summary");
					}
					repairSummary = recomputed;
				}
				if (summary.restore) {
					cross.restoreEqual =
						restoreSummary !== undefined &&
						canonicalJson(restoreSummary) === canonicalJson(summary.restore);
					if (!cross.restoreEqual)
						cross.differences.push("restore totals differ from the summary");
				}
				if (summary.normalize) {
					cross.normalizeEqual =
						normalizeSummary !== undefined &&
						canonicalJson(normalizeSummary) ===
							canonicalJson(summary.normalize);
					if (!cross.normalizeEqual)
						cross.differences.push("normalize totals differ from the summary");
				}
			}
		}

		const str = (v: unknown) => (typeof v === "string" ? v : null);
		return {
			exportVersion: EXPORT_VERSION,
			exportedAt: new Date().toISOString(),
			run: {
				runId: run.run_id,
				kind: run.kind,
				parentRunId: run.parent_run_id,
				status: run.status,
				createdAt: run.created_at,
				finishedAt: run.finished_at,
				note: run.note,
				configDigest: run.config_digest,
			},
			config,
			inputs,
			provenance: {
				catalogVersion: str(inputs.catalogVersion),
				snapshotSha256: str(inputs.snapshotSha256),
				contractsSha256: str(inputs.contractsSha256),
				fixturesSha256: str(inputs.fixturesSha256),
				contractVersion: str(config.contractVersion),
				contractVersionAtExport: CONTRACT_VERSION,
				casesPinned: pinned !== null,
				caseSetSha256: pinned?.snapshot.digest ?? null,
			},
			condition:
				config.condition && typeof config.condition === "object"
					? (config.condition as ConditionSummary)
					: null,
			cases,
			cells,
			byFormat,
			totals,
			...(repairSummary ? { repair: repairSummary } : {}),
			...(restoreSummary ? { restore: restoreSummary } : {}),
			...(normalizeSummary ? { normalize: normalizeSummary } : {}),
			summaryCrossCheck: cross,
		};
	} finally {
		db.close();
	}
}

/** A compact human-readable rendering of an export: identity, totals, failures, checks. */
export function renderExportMarkdown(exp: RunExport): string {
	const lines: string[] = [];
	const yn = (v: boolean | null) => (v === null ? "n/a" : v ? "yes" : "NO");
	lines.push(`# Run export ${exp.run.runId}`);
	lines.push("");
	lines.push(
		`- kind: ${exp.run.kind} / status: ${exp.run.status} / parent: ${exp.run.parentRunId ?? "none"}`,
	);
	lines.push(
		`- session: ${exp.summaryCrossCheck.session ?? "n/a"} / condition: ${exp.condition?.id ?? "n/a"} (cardSet ${exp.condition?.cardSet ?? "n/a"}, style ${exp.condition?.cardStyle ?? "n/a"}, shots ${exp.condition?.shots ?? "n/a"}, output ${exp.condition?.outputStyle ?? "n/a"})`,
	);
	lines.push(
		`- created: ${exp.run.createdAt} / finished: ${exp.run.finishedAt ?? "n/a"} / exported: ${exp.exportedAt}`,
	);
	lines.push(
		`- catalog: ${exp.provenance.catalogVersion ?? "n/a"} / snapshot: ${exp.provenance.snapshotSha256 ?? "n/a"} / contracts: ${exp.provenance.contractsSha256 ?? "n/a"} / fixtures: ${exp.provenance.fixturesSha256 ?? "n/a"}`,
	);
	lines.push(
		`- contract version recorded by the run: ${exp.provenance.contractVersion ?? "none (pre-P3 run; the digests above are its pins)"} / at export: ${exp.provenance.contractVersionAtExport}`,
	);
	lines.push(
		"- definitions: cells that authored a valid definition carry it in the JSON export in saved form (pretty-printed JSON, even when the model wrote minified output); raw outputs stay in the work db and recordings",
	);
	lines.push("");
	lines.push("## Totals (recomputed from the work db)");
	lines.push("");
	lines.push(
		"| scope | cells | scored | parse | authoring | check | state | bundles | mock | passed |",
	);
	lines.push(
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	const row = (label: string, g: FormatGroupSummary) =>
		`| ${label} | ${g.cells} | ${g.scored} | ${g.parseOk} | ${g.authoringOk} | ${g.checkOk}/${g.checkAttempts} | ${g.stateMatch} | ${g.bundlesOk} | ${g.mockCompleted}/${g.mockAttempts} | ${g.passed} |`;
	for (const [format, groups] of Object.entries(exp.byFormat)) {
		lines.push(row(`${format} catalog-only`, groups.catalogOnly));
		lines.push(row(`${format} fixture-dependent`, groups.fixtureDependent));
		lines.push(row(`${format} total`, groups.total));
	}
	lines.push(row("ALL", exp.totals));
	lines.push("");
	const promptTotal = exp.cells.reduce((a, c) => a + (c.promptTokens ?? 0), 0);
	const outputTotal = exp.cells.reduce((a, c) => a + (c.outputTokens ?? 0), 0);
	const counted = exp.cells.filter((c) => c.promptTokens !== null).length;
	lines.push(
		`Tokens (from the session summary; ${counted}/${exp.cells.length} cells counted): prompt ${counted ? promptTotal : "n/a"}, output ${counted ? outputTotal : "n/a"}.`,
	);
	if (exp.repair) {
		const r = exp.repair;
		lines.push("");
		lines.push("## Repair");
		lines.push("");
		lines.push(
			`attempted ${r.attempted} (scored ${r.scored}, missing ${r.missing}, digest-mismatch ${r.digestMismatch}, inference-error ${r.inferenceErrors}); passed ${r.passedBefore} -> ${r.passedAfter}; repair tokens prompt ${r.promptTokens ?? "n/a"}, output ${r.outputTokens ?? "n/a"}.`,
		);
	}
	if (exp.restore) {
		lines.push("");
		lines.push("## Syntax restore");
		lines.push("");
		lines.push(
			`attempted ${exp.restore.attempted} composing cells, recovered ${exp.restore.recovered}; per-cell flags are in the JSON export (raw outputs unchanged in the work db).`,
		);
	}
	if (exp.normalize) {
		lines.push("");
		lines.push("## Step-id normalization");
		lines.push("");
		lines.push(
			`attempted ${exp.normalize.attempted} composing cells, recovered ${exp.normalize.recovered}; per-cell flags are in the JSON export (raw outputs unchanged in the work db).`,
		);
	}
	lines.push("");
	lines.push("## Cases (gold provenance)");
	lines.push("");
	lines.push("| case | split | group | expected | fixture | gold sha256 |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const c of exp.cases)
		lines.push(
			`| ${c.id} | ${c.split} | ${c.group ?? "-"} | ${c.expectedKind} | ${c.usesFixtureContracts ? "yes" : "no"} | ${c.goldSha256.slice(0, 12)}… |`,
		);
	lines.push("");
	lines.push("## Failed and unscored cells");
	lines.push("");
	const failed = exp.cells.filter((c) => c.status !== "scored" || !c.passed);
	if (!failed.length) lines.push("none");
	for (const c of failed) {
		const aspects = c.score
			? Object.entries(c.score.score)
					.filter(([, v]) => !v)
					.map(([k]) => k)
					.join(", ")
			: "";
		lines.push(
			`- ${c.caseId} / ${c.format}: status ${c.status}${c.status === "scored" ? `, failing: ${aspects || "authoring"}` : `, error: ${c.error ?? "n/a"}`}`,
		);
	}
	lines.push("");
	lines.push("## Summary cross-check");
	lines.push("");
	const cross = exp.summaryCrossCheck;
	lines.push(
		`- summary found: ${cross.summaryFound ? "yes" : "no"} / belongs to this run: ${cross.runMatches ? "yes" : `no (summary run: ${cross.summaryRunId ?? "n/a"})`}`,
	);
	lines.push(
		`- totals equal: ${yn(cross.totalsEqual)} / cells equal: ${yn(cross.cellsEqual)} / repair equal: ${yn(cross.repairEqual)} / restore equal: ${yn(cross.restoreEqual)} / normalize equal: ${yn(cross.normalizeEqual)}`,
	);
	for (const d of cross.differences) lines.push(`- difference: ${d}`);
	lines.push("");
	return `${lines.join("\n")}`;
}
