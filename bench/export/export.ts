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
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION } from "../../src/contracts/record.ts";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import { DEFAULT_CASES_DIR, loadCases } from "../cases/cases.ts";
import type { ConditionSummary } from "../format/conditions.ts";
import {
	DEFAULT_RUNS_ROOT,
	type FormatGroupSummary,
	type FormatRepairSummary,
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
	summaryCrossCheck: SummaryCrossCheck;
};

type TrialRow = {
	trial_id: string;
	case_id: string;
	condition: string;
	attempt: number;
	phase: string;
	status: string;
	output_digest: string | null;
	error: string | null;
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
	promptTokens: number | null;
	outputTokens: number | null;
	repair?: {
		status: string;
		before: RepairVerdict;
		after?: RepairVerdict;
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
		const allCases = loadCases(casesDir);
		const caseById = new Map(allCases.map((c) => [c.id, c]));
		const cases: ExportCase[] = caseIds.map((id) => {
			const found = caseById.get(id);
			if (!found) throw new Error(`export: run names unknown case "${id}"`);
			const raw = readFileSync(join(casesDir, `${id}.json`), "utf8");
			return {
				id,
				split: found.split,
				group: found.group ?? null,
				expectedKind: found.expected.kind,
				usesFixtureContracts: found.usesFixtureContracts,
				goldSource: `${casesDir}/${id}.json`,
				goldSha256: sha256(raw),
			};
		});
		const fixtureByCase = new Map(
			cases.map((c) => [c.id, c.usesFixtureContracts]),
		);

		// Trials and their recorded detail.
		const trials = db
			.query<TrialRow, [string]>(
				"SELECT trial_id, case_id, condition, attempt, phase, status, output_digest, error FROM trials WHERE run_id = ? ORDER BY case_id, condition, attempt",
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

		const cells: ExportCell[] = composeTrials.map((trial) => {
			const { criteria, score, checks, model } = detailOf(trial);
			const status = cellStatus(trial);
			const scored = status === "scored";
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
			repairByCell.set(key, {
				status,
				trialId: trial.trial_id,
				before: verdictOf(cell.score, cell.authoringOk, cell.passed),
				after:
					status === "scored"
						? verdictOf(score, criteria.authoring === 1, criteria.passed === 1)
						: null,
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
		`- session: ${exp.summaryCrossCheck.session ?? "n/a"} / condition: ${exp.condition?.id ?? "n/a"} (cardSet ${exp.condition?.cardSet ?? "n/a"}, style ${exp.condition?.cardStyle ?? "n/a"}, shots ${exp.condition?.shots ?? "n/a"})`,
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
		`- totals equal: ${yn(cross.totalsEqual)} / cells equal: ${yn(cross.cellsEqual)} / repair equal: ${yn(cross.repairEqual)}`,
	);
	for (const d of cross.differences) lines.push(`- difference: ${d}`);
	lines.push("");
	return `${lines.join("\n")}`;
}
