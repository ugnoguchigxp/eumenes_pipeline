import {
	recordPreparedRequests,
	type PreparedApiRequest,
} from "../infer/prepared.ts";
/**
 * bench:format — the format comparison runner (plan §10 P0c/P0d).
 *
 * One invocation = one work-db run over (case × format) cells under ONE prompt condition
 * (`conditions.ts`: which cards are offered, how they are rendered, whether the prompt
 * carries a worked example; the `baseline` condition is every offered card, full rendering,
 * no example). Inference uses recorded files (`bench/infer/recorded.ts`), with legacy or
 * verified API provenance: this runner never calls a model. It builds and digests each prompt,
 * then looks for the recording the
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
 *
 * Syntax restore (opt-in, `restoreSyntax: true`): a `json` output the strict parser
 * rejects gets one deterministic restore (`bench/formats/restore.ts`, engine recorded
 * in the run config), and the restored text must pass the same strict parser —
 * duplicates and every other strictness rule still apply. This is a different failure
 * class from repair: restore undoes surface syntax damage (trailing commas, fences,
 * truncation) with no model call, while repair returns semantic machine errors
 * (schema / check) to the model. Recordings are never rewritten; restore happens in
 * memory at evaluation time. Each attempt records whether restore was offered and
 * whether it recovered the parse (cell flag + run totals + a `syntax_restored` score
 * criterion), so the raw parse rate stays separable. Off by default: a run without
 * it is byte-for-byte the pre-restore bench.
 *
 * Step-id normalization (opt-in, `normalizeIds: true`): a parsed `ready` outcome that
 * fails the authoring gate ONLY on step-id shape (the contract pattern — snake_case
 * above all) gets one deterministic rewrite of the offending ids and their references
 * (`bench/formats/normalize-ids.ts`), then the same gate again. It is the same family
 * as syntax restore — a mechanical failure class removed without a model call — one
 * level up: where restore fixes the text's syntax, normalization fixes the parsed
 * definition's id shape, and only when the rewrite is injective (a collision, or a
 * landing on the reserved `request` reference, leaves the original failure standing,
 * errors unchanged, so a later repair round still sees the model's own mistake).
 * Each attempt records whether normalization was offered and whether it recovered
 * the gate (cell flag + run totals + an `ids_normalized` score criterion), so the
 * raw authoring rate stays separable. Off by default: a run without it is
 * byte-for-byte the pre-normalization bench.
 *
 * Triage (opt-in, `triage: true`): before composing, one short recorded call per
 * case judges only whether the request's information is sufficient
 * (`bench/format/triage.ts`); its conclusion is appended to the composing prompt
 * as an advisory section, and the composer keeps the final judgment. Triage has
 * its own traffic — requests under `<session>/triage-requests/`, recordings under
 * `<session>/triage-recordings/`, trials recorded as phase `triage` — and a case
 * without a usable triage conclusion blocks its composing cells (reported
 * missing / digest-mismatch / inference-error, exactly like a missing composing
 * recording) rather than composing without the pre-pass the condition promises.
 * Off by default: a run without it is byte-for-byte the pre-triage bench.
 *
 * Staged generation (opt-in, `staged: true`): long workflows are generated in
 * stages, never one-shot (the user's direction, 2026-11-04). Stage A enumerates
 * the request's work items (`bench/format/enumerate.ts`) in its own recorded
 * call per case — traffic under `<session>/enum-requests/` and
 * `<session>/enum-recordings/`, trials as phase `enum`, blocking semantics
 * exactly like triage — and the composing prompt carries the item list plus the
 * marker convention (each step's `task` head cites the item ids it covers).
 * The evaluator computes the deterministic coverage (enumerated ids minus cited
 * ids) from the raw parse and strips the markers before authoring, checking and
 * scoring: the markers are a bench-side auxiliary channel, never part of the
 * definition contract. The cell report and summary carry the coverage counts.
 * Coverage repair (opt-in, `coverageRepair: true`, requires `staged`): a
 * mechanically sound staged cell whose steps leave enumerated items uncovered
 * gets the one repair round with the uncovered items as machine errors
 * (`[coverage] w5: <item text>`), and the repair may INSERT steps to cover them.
 * It shares the repair traffic and machinery; a mechanically failed cell is
 * never coverage-repaired (the mechanical class keeps its own round, when
 * enabled). Off by default: a run without them is byte-for-byte the pre-staged
 * bench.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDefinition, type CheckResult } from "../../src/check.ts";
import type { InferenceResult } from "../../src/ports.ts";
import type { AuthoringOutcome } from "../../src/contracts/authoring.ts";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { CONTRACT_VERSION } from "../../src/contracts/record.ts";
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, DEFAULT_CASES_DIR, type EvalCase } from "../cases/cases.ts";
import { captureCases } from "../cases/provenance.ts";
import { verifyFreeze } from "../cases/freeze.ts";
import { FORMAT_PARSERS, FORMAT_IDS, type FormatId } from "../formats/index.ts";
import {
	ID_NORMALIZE_VERSION,
	validateAuthoring,
} from "../formats/normalize-ids.ts";
import type { ParseResult } from "../formats/outcome.ts";
import { parseJsonWithRestore, RESTORE_ENGINE } from "../formats/restore.ts";
import {
	COMPOSE_PURPOSE,
	ENUM_PURPOSE,
	inferenceDigest,
	RecordedInference,
	REPAIR_PURPOSE,
	TRIAGE_PURPOSE,
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
	GUIDANCE_TEXTS,
	PROMPT_TEMPLATE_VERSION,
} from "./prompt.ts";
import {
	buildHostPrompt,
	loadHostPrompt,
	parseHostOutput,
} from "./host-prompt.ts";
import { bindSourceRequest } from "../../src/source-request.ts";
import {
	buildEnumPrompt,
	computeCoverage,
	coverageErrorLine,
	enumNoteText,
	ENUM_TEMPLATE_VERSION,
	parseEnumOutput,
	stripItemMarkers,
	type CoverageResult,
	type EnumConclusion,
	type WorkItem,
} from "./enumerate.ts";
import {
	buildTriagePrompt,
	parseTriageOutput,
	TRIAGE_TEMPLATE_VERSION,
	triageNoteText,
	type TriageConclusion,
	type TriageVerdict,
} from "./triage.ts";

export const DEFAULT_RUNS_ROOT = "data/runs/format";
export const FORMAT_SCORER = "bench-format-v3";

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
	/**
	 * The composing attempt's parse was recovered by the syntax-restore stage.
	 * Present only in restore runs (for scored cells); the raw output is unchanged.
	 */
	syntaxRestored?: boolean;
	/**
	 * The composing attempt's authoring gate was recovered by step-id normalization.
	 * Present only in normalization runs (for scored cells); the raw output is unchanged.
	 */
	idsNormalized?: boolean;
	/** The triage pre-pass conclusion this cell's prompt carried; present only in triage runs. */
	triage?: { verdict: TriageVerdict; questions: string[] };
	/**
	 * Stage-A item coverage of the composing attempt (staged runs, ready
	 * definitions only): how many enumerated items the steps cite, and which
	 * item ids no step cites.
	 */
	coverage?: { total: number; covered: number; uncovered: string[] };
	/** The one repair round of a mechanically failed cell; present only in repair runs. */
	repair?: FormatCellRepair;
};

/** Run totals of the triage pre-pass; present only in triage runs. Counts are per case. */
export type FormatTriageSummary = {
	/** Cases the run covers (one triage call each). */
	cases: number;
	/** Cases whose triage call produced a usable conclusion. */
	concluded: number;
	proceed: number;
	needsInput: number;
	/** Cases with no triage recording (their composing cells are blocked as missing). */
	missing: number;
	digestMismatch: number;
	/** Cases whose triage output was served but is not a valid verdict document. */
	invalid: number;
	/** Total triage prompt tokens over concluded/missing-counted calls; null when any could not be counted. */
	promptTokens: number | null;
	/** Total triage output tokens over the calls that produced an output; null likewise. */
	outputTokens: number | null;
};

/** Run totals of the stage-A enumeration; present only in staged runs. Counts are per case. */
export type FormatEnumSummary = {
	/** Cases the run covers (one enumeration call each). */
	cases: number;
	/** Cases whose enumeration produced a usable item list. */
	concluded: number;
	/** Cases with no enumeration recording (their composing cells are blocked as missing). */
	missing: number;
	digestMismatch: number;
	/** Cases whose enumeration output was served but is not a valid item list. */
	invalid: number;
	/** Enumerated items over the concluded cases. */
	items: number;
	/** Total enumeration prompt tokens; null when any could not be counted. */
	promptTokens: number | null;
	/** Total enumeration output tokens over the calls that produced an output; null likewise. */
	outputTokens: number | null;
};

/** Run totals of the syntax-restore stage; present only in restore runs. */
export type FormatRestoreSummary = {
	/** Composing cells whose raw output failed the strict parser and were offered restore. */
	attempted: number;
	/** Of those, cells whose parse the restored text recovered. */
	recovered: number;
};

/** Run totals of the step-id normalization stage; present only in normalization runs. */
export type FormatNormalizeSummary = {
	/** Composing cells whose authoring gate failed on step-id shape alone and were offered normalization. */
	attempted: number;
	/** Of those, cells whose gate the rewritten definition recovered. */
	recovered: number;
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
	/** The repair attempt's parse was recovered by syntax restore; present only in restore runs. */
	syntaxRestored?: boolean;
	/** The repair attempt's authoring gate was recovered by step-id normalization; present only in normalization runs. */
	idsNormalized?: boolean;
	/** Item coverage of the repaired attempt (staged runs); present when it was computed. */
	coverageAfter?: { total: number; covered: number };
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
	/** Syntax-restore totals over the composing cells; present only in restore runs. */
	restore?: FormatRestoreSummary;
	/** Step-id normalization totals over the composing cells; present only in normalization runs. */
	normalize?: FormatNormalizeSummary;
	/** Triage pre-pass totals; present only in triage runs. */
	triage?: FormatTriageSummary;
	/** Stage-A enumeration totals; present only in staged runs. */
	staged?: FormatEnumSummary;
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
 * The P0b contract gate lives in `bench/formats/normalize-ids.ts`
 * (`validateAuthoring`): a parsed outcome still has to be a valid
 * `AuthoringOutcome`, and — in normalization runs — a failure on step-id shape
 * alone gets the one deterministic rewrite described in the module header. On
 * failure the schema's own issues are kept (path + message, verbatim) — they are
 * the machine errors a repair round may be shown.
 */

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
	/** The strict parser failed on the raw text and syntax restore was offered (restore runs only). */
	restoreAttempted: boolean;
	/** The restored text recovered the parse; `parse` is the restored parse. */
	syntaxRestored: boolean;
	/** The authoring gate failed on step-id shape alone and normalization was offered (normalization runs only). */
	normalizeAttempted: boolean;
	/** The rewritten definition recovered the authoring gate; `authored` is the normalized outcome. */
	idsNormalized: boolean;
	/**
	 * Stage-A item coverage of this attempt (staged runs, ready outcomes only),
	 * computed from the raw parse BEFORE the markers were stripped for scoring.
	 */
	coverage?: CoverageResult;
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

export const COVERAGE_REPAIR_TEMPLATE_VERSION = "coverage-repair-v1";

const COVERAGE_REPAIR_SYSTEM = `あなたは、手順定義の出力をカバレッジ検査にかけて返ってきた不足を直す修復担当です。

進め方:
- 前回の出力と、担当する手順が無い作業項目の一覧が渡されます。
- 直すのは、その不足が解消するために必要な箇所だけです。既にある手順の内容・部品の選択・配線は変えず、不足している項目を担当する手順を追加してください。追加する手順の task の冒頭にも、担当する項目の印を [w1] の形で置いてください。
- 既にある手順がその項目の作業を実は担っているのに印が付いていない場合は、その手順の task の冒頭に印を付け足すだけでも構いません。
- 出力は、元の出力と同じ形式の規則で、修正後の出力の全文だけにしてください。説明や前置きは付けないでください。`;

/**
 * The one coverage-repair prompt of a staged cell (stage C). Its whole content
 * is the original composing request (system + prompt — which carries the item
 * list and the marker convention), the model's original output, and the
 * uncovered items as machine errors. Built without the case's expected values,
 * which this module's caller never passes in.
 */
export function buildCoverageRepairPrompt(input: {
	system: string;
	prompt: string;
	output: string;
	errors: readonly string[];
}): { system: string; prompt: string } {
	return {
		system: COVERAGE_REPAIR_SYSTEM,
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
			"## カバレッジ検査のエラー（担当する手順が無い作業項目）",
			...input.errors.map((line) => `- ${line}`),
			"",
			"上の項目を担当する手順が揃うように直した、前回の出力の全文を返してください。",
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
	freezePath?: string;
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
	/**
	 * One deterministic syntax-restore stage in front of the strict parser, `json`
	 * format only (see the module header). Off by default: a run without it is
	 * byte-for-byte the pre-restore bench — same prompts, same digests, same summary
	 * shape, same recorded criteria.
	 */
	restoreSyntax?: boolean;
	/**
	 * One deterministic step-id normalization stage at the authoring gate (see the
	 * module header). Off by default: a run without it is byte-for-byte the
	 * pre-normalization bench — same prompts, same digests, same summary shape,
	 * same recorded criteria.
	 */
	normalizeIds?: boolean;
	/**
	 * One triage pre-pass per case whose conclusion the composing prompt carries
	 * (see the module header). Off by default: a run without it is byte-for-byte
	 * the pre-triage bench.
	 */
	triage?: boolean;
	/**
	 * Staged generation (see the module header): one enumeration pre-pass per
	 * case, the item list and marker convention in the composing prompt, and
	 * deterministic item coverage on every ready attempt. Off by default: a run
	 * without it is byte-for-byte the pre-staged bench.
	 */
	staged?: boolean;
	/**
	 * The coverage review (stage C): one repair round for mechanically sound
	 * staged cells that leave enumerated items uncovered, fed the uncovered
	 * items as machine errors, with step insertion allowed (see the module
	 * header). Requires `staged`. Off by default.
	 */
	coverageRepair?: boolean;
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
	if (options.coverageRepair && !options.staged)
		throw new Error(
			"coverageRepair requires staged (stage C reviews stage A's items)",
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
	if (options.repair || options.coverageRepair) {
		mkdirSync(repairRequestsDir, { recursive: true });
		mkdirSync(repairRecordingsDir, { recursive: true });
	}
	const triageRequestsDir = join(sessionDir, "triage-requests");
	const triageRecordingsDir = join(sessionDir, "triage-recordings");
	if (options.triage) {
		mkdirSync(triageRequestsDir, { recursive: true });
		mkdirSync(triageRecordingsDir, { recursive: true });
	}
	const enumRequestsDir = join(sessionDir, "enum-requests");
	const enumRecordingsDir = join(sessionDir, "enum-recordings");
	if (options.staged) {
		mkdirSync(enumRequestsDir, { recursive: true });
		mkdirSync(enumRecordingsDir, { recursive: true });
	}

	const frozen = options.freezePath
		? verifyFreeze(
				options.freezePath,
				options.session,
				undefined,
				options.casesDir ?? DEFAULT_CASES_DIR,
			)
		: undefined;
	if (frozen) {
		const method = {
			condition: options.condition ?? BASELINE_CONDITION,
			formats: options.formats ?? FORMAT_IDS,
			repair: !!options.repair,
			restoreSyntax: !!options.restoreSyntax,
			normalizeIds: !!options.normalizeIds,
			triage: !!options.triage,
			staged: !!options.staged,
			coverageRepair: !!options.coverageRepair,
			candidates: options.candidates ?? null,
		};
		if (canonicalJson(method) !== canonicalJson(frozen.protocol.formatMethod))
			throw new Error("format method differs from frozen protocol");
	}
	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	const allCases = loadCases(options.casesDir);
	if (frozen && options.caseIds && options.caseIds.length !== allCases.length)
		throw new Error("frozen evaluation cannot select a partial case set");
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
	// The host-prompt condition sends Eumenes' own composing prompt: JSON only, no other
	// prompt option, and the snapshot it came from is part of the recorded condition.
	const hostPrompt =
		condition.promptStyle === "eumenes-p0-3" ? loadHostPrompt() : undefined;
	if (hostPrompt) {
		if (formats.some((f) => f !== "json"))
			throw new Error(
				"the eumenes prompt style is defined for the json format only",
			);
		if (
			condition.shots !== 0 ||
			condition.guidance ||
			condition.cardStyle !== "full" ||
			condition.outputStyle !== "default" ||
			options.triage ||
			options.staged ||
			options.repair ||
			options.coverageRepair ||
			options.restoreSyntax ||
			options.normalizeIds
		)
			throw new Error(
				"the eumenes prompt style takes no other option (shots, guidance, card style, output style, triage, staged, repair, restore, normalize): the host has its own repair message, unmeasured here",
			);
	}
	const conditionInfo = {
		...summarizeCondition(condition, options.candidates !== undefined),
		...(hostPrompt
			? {
					hostPrompt: {
						instructionsSha256: hostPrompt.instructionsSha256,
						gitCommit: hostPrompt.gitCommit,
					},
				}
			: {}),
	};
	const provenance = tokenizerProvenance();

	// Triage resolution (triage runs only): one recorded call per case, resolved
	// BEFORE the composing prompts are built, because a concluded case's prompt
	// carries the conclusion. The calls are recorded as work-db trials once the
	// run exists (below); here only files and recordings are touched.
	type TriageResolution = {
		evalCase: EvalCase;
		system: string;
		prompt: string;
		state:
			| "concluded"
			| "missing"
			| "digest-mismatch"
			| "invalid"
			| "inference-error";
		conclusion?: TriageConclusion;
		/** The served inference result, when a recording answered the call. */
		result?: InferenceResult;
		error?: string;
	};
	const triageResolutions = new Map<string, TriageResolution>();
	if (options.triage) {
		const triageRecordings =
			RecordedInference.fromDirectory(triageRecordingsDir);
		for (const evalCase of cases) {
			const built = buildTriagePrompt(evalCase);
			const request = {
				purpose: TRIAGE_PURPOSE,
				system: built.system,
				prompt: built.prompt,
			};
			const digest = inferenceDigest(request);
			const fileName = `${evalCase.id}.json`;
			const base = { evalCase, system: built.system, prompt: built.prompt };
			const recording = triageRecordings.files.get(fileName);
			if (!recording) {
				writeFileSync(
					join(triageRequestsDir, fileName),
					`${JSON.stringify(
						{
							caseId: evalCase.id,
							purpose: TRIAGE_PURPOSE,
							system: built.system,
							prompt: built.prompt,
							promptDigest: digest,
						},
						null,
						"\t",
					)}\n`,
				);
				triageResolutions.set(evalCase.id, {
					...base,
					state: "missing",
					error: `missing triage recording; request written to triage-requests/${fileName}`,
				});
				continue;
			}
			if (recording.promptDigest !== digest) {
				triageResolutions.set(evalCase.id, {
					...base,
					state: "digest-mismatch",
					error: `triage recording digest mismatch: prompt digest is ${digest}, recording claims ${recording.promptDigest}; recording refused`,
				});
				continue;
			}
			const result = await triageRecordings.inference.complete(request);
			if (!result.ok) {
				triageResolutions.set(evalCase.id, {
					...base,
					state: "inference-error",
					result,
					error: result.error,
				});
				continue;
			}
			const conclusion = parseTriageOutput(result.text);
			if (conclusion)
				triageResolutions.set(evalCase.id, {
					...base,
					state: "concluded",
					conclusion,
					result,
				});
			else
				triageResolutions.set(evalCase.id, {
					...base,
					state: "invalid",
					result,
					error:
						'triage output is not a verdict document (expected {"verdict": "proceed"} or {"verdict": "needs_input", "questions": [...]})',
				});
		}
	}

	// Enumeration resolution (staged runs only): one recorded call per case,
	// resolved BEFORE the composing prompts are built, because a concluded
	// case's prompt carries the item list. Same shape as the triage resolution;
	// the calls are recorded as work-db trials once the run exists (below).
	type EnumResolution = {
		evalCase: EvalCase;
		system: string;
		prompt: string;
		state:
			| "concluded"
			| "missing"
			| "digest-mismatch"
			| "invalid"
			| "inference-error";
		conclusion?: EnumConclusion;
		/** The served inference result, when a recording answered the call. */
		result?: InferenceResult;
		error?: string;
	};
	const enumResolutions = new Map<string, EnumResolution>();
	if (options.staged) {
		const enumRecordings = RecordedInference.fromDirectory(enumRecordingsDir);
		for (const evalCase of cases) {
			const built = buildEnumPrompt(evalCase);
			const request = {
				purpose: ENUM_PURPOSE,
				system: built.system,
				prompt: built.prompt,
			};
			const digest = inferenceDigest(request);
			const fileName = `${evalCase.id}.json`;
			const base = { evalCase, system: built.system, prompt: built.prompt };
			const recording = enumRecordings.files.get(fileName);
			if (!recording) {
				writeFileSync(
					join(enumRequestsDir, fileName),
					`${JSON.stringify(
						{
							caseId: evalCase.id,
							purpose: ENUM_PURPOSE,
							system: built.system,
							prompt: built.prompt,
							promptDigest: digest,
						},
						null,
						"\t",
					)}\n`,
				);
				enumResolutions.set(evalCase.id, {
					...base,
					state: "missing",
					error: `missing enumeration recording; request written to enum-requests/${fileName}`,
				});
				continue;
			}
			if (recording.promptDigest !== digest) {
				enumResolutions.set(evalCase.id, {
					...base,
					state: "digest-mismatch",
					error: `enumeration recording digest mismatch: prompt digest is ${digest}, recording claims ${recording.promptDigest}; recording refused`,
				});
				continue;
			}
			const result = await enumRecordings.inference.complete(request);
			if (!result.ok) {
				enumResolutions.set(evalCase.id, {
					...base,
					state: "inference-error",
					result,
					error: result.error,
				});
				continue;
			}
			const conclusion = parseEnumOutput(result.text);
			if (conclusion)
				enumResolutions.set(evalCase.id, {
					...base,
					state: "concluded",
					conclusion,
					result,
				});
			else
				enumResolutions.set(evalCase.id, {
					...base,
					state: "invalid",
					result,
					error:
						'enumeration output is not an item list (expected {"items": ["...", ...]})',
				});
		}
	}

	// Build every prompt up front and count them in one batch: the prompt of a cell does
	// not depend on its recording, and one helper call keeps the counting cheap.
	type PreparedCell = {
		evalCase: EvalCase;
		format: FormatId;
		system: string;
		prompt: string;
		promptTokens: number | null;
		/** The triage conclusion the prompt carries (triage runs, concluded cases). */
		triageConclusion?: TriageConclusion;
		/** Why this cell cannot compose (triage runs, unconcluded cases). */
		triageBlocked?: { status: FormatCellStatus; error: string };
		/** The stage-A conclusion the prompt carries (staged runs, concluded cases). */
		enumConclusion?: EnumConclusion;
		/** Why this cell cannot compose (staged runs, unconcluded cases). */
		enumBlocked?: { status: FormatCellStatus; error: string };
	};
	const prepared: PreparedCell[] = [];
	for (const evalCase of cases)
		for (const format of formats) {
			const triage = triageResolutions.get(evalCase.id);
			const enumeration = enumResolutions.get(evalCase.id);
			const cards = selectCards(
				condition,
				options.candidates,
				evalCase,
				catalog.cards,
			);
			const built = hostPrompt
				? buildHostPrompt({ evalCase, cards, host: hostPrompt })
				: buildFormatPrompt({
						evalCase,
						format,
						cards,
						cardStyle: condition.cardStyle,
						outputStyle: condition.outputStyle,
						...(condition.shots === 1
							? { workedExample: WORKED_EXAMPLES[format] }
							: {}),
						...(condition.guidance
							? { guidanceText: GUIDANCE_TEXTS[condition.guidance] }
							: {}),
						...(triage?.conclusion
							? { triageNote: triageNoteText(triage.conclusion) }
							: {}),
						...(enumeration?.conclusion
							? { enumNote: enumNoteText(enumeration.conclusion) }
							: {}),
					});
			const blockedOf = (
				resolution:
					{ state: string; error?: string; conclusion?: unknown } | undefined,
				label: string,
			) =>
				resolution && !resolution.conclusion
					? {
							status:
								resolution.state === "missing"
									? ("missing" as const)
									: resolution.state === "digest-mismatch"
										? ("digest-mismatch" as const)
										: ("inference-error" as const),
							error: `${label} pre-pass unavailable: ${resolution.error ?? resolution.state}`,
						}
					: undefined;
			const triageBlocked = blockedOf(triage, "triage");
			const enumBlocked = blockedOf(enumeration, "enumeration");
			prepared.push({
				evalCase,
				format,
				...built,
				promptTokens: null,
				...(triage?.conclusion ? { triageConclusion: triage.conclusion } : {}),
				...(triageBlocked ? { triageBlocked } : {}),
				...(enumeration?.conclusion
					? { enumConclusion: enumeration.conclusion }
					: {}),
				...(enumBlocked ? { enumBlocked } : {}),
			});
		}
	const promptCounts = countTokens(
		prepared.map((cell) => `${cell.system}\n${cell.prompt}`),
	);
	prepared.forEach((cell, i) => {
		cell.promptTokens = promptCounts[i] ?? null;
	});

	const composeRecordings = RecordedInference.fromDirectory(recordingsDir);
	const preparedRepairRecordings =
		options.repair || options.coverageRepair
			? RecordedInference.fromDirectory(repairRecordingsDir)
			: undefined;
	const apiSources = Object.fromEntries(composeRecordings.provenance);
	const work = openWorkDb(options.dbPath ?? DEFAULT_WORK_DB);
	const runId = work.startRun({
		kind: "format",
		config: {
			...(frozen ? { freezeDigest: frozen.digest } : {}),
			...(preparedRepairRecordings
				? {
						repairEvidence:
							preparedRepairRecordings.provenance.size > 0
								? "api-replay"
								: "agent-model",
					}
				: {}),
			evidence:
				composeRecordings.provenance.size > 0
					? composeRecordings.provenance.size === composeRecordings.files.size
						? "api-replay"
						: "mixed-recordings"
					: "agent-model",
			contractVersion: CONTRACT_VERSION,
			formats,
			promptTemplate: PROMPT_TEMPLATE_VERSION,
			cardsRendering: CARDS_RENDERING,
			cards: catalog.cards.length,
			policy: catalog.policy,
			seed,
			session: options.session,
			condition: conditionInfo,
			conditionDefinition: condition,
			tokenizer: provenance,
			...(options.repair
				? { repair: true, repairTemplate: REPAIR_TEMPLATE_VERSION }
				: {}),
			...(options.restoreSyntax
				? { restoreSyntax: true, restoreEngine: RESTORE_ENGINE }
				: {}),
			...(options.normalizeIds
				? { normalizeIds: true, normalizeVersion: ID_NORMALIZE_VERSION }
				: {}),
			...(options.triage
				? { triage: true, triageTemplate: TRIAGE_TEMPLATE_VERSION }
				: {}),
			...(options.staged
				? { staged: true, enumTemplate: ENUM_TEMPLATE_VERSION }
				: {}),
			...(options.coverageRepair
				? {
						coverageRepair: true,
						coverageRepairTemplate: COVERAGE_REPAIR_TEMPLATE_VERSION,
					}
				: {}),
		},
		inputs: {
			snapshotSha256: catalog.snapshot.sha256,
			contractsSha256: catalog.contracts.contractsSha256,
			fixturesSha256: catalog.contracts.fixturesSha256,
			catalogVersion: catalog.view.version,
			caseIds: cases.map((c) => c.id),
			caseSnapshot: captureCases(cases, options.casesDir),
			...(options.candidates ? { candidates: options.candidates } : {}),
			...(composeRecordings.provenance.size > 0 ? { apiSources } : {}),
			...(preparedRepairRecordings?.provenance.size
				? {
						apiRepairSources: Object.fromEntries(
							preparedRepairRecordings.provenance,
						),
					}
				: {}),
		},
	});

	const cells: FormatCellReport[] = [];
	const outputs = new Map<string, string>();
	const evaluations = new Map<string, EvaluatedAttempt>();
	const repairPromptTexts = new Map<string, string>();
	const repairOutputTexts = new Map<string, string>();
	const cellKey = (cell: { caseId: string; format: FormatId }) =>
		`${cell.caseId}\0${cell.format}`;
	const preparedRequests: PreparedApiRequest[] = prepared
		.filter((c) => !c.triageBlocked && !c.enumBlocked)
		.map((c) => ({
			phase: "compose",
			name: `${c.evalCase.id}--${c.format}.json`,
			promptDigest: inferenceDigest({
				purpose: COMPOSE_PURPOSE,
				system: c.system,
				prompt: c.prompt,
			}),
		}));
	let sweepDone = false;
	try {
		// Record the triage calls as this run's trials (phase `triage`, one per case).
		if (options.triage) {
			for (const resolution of triageResolutions.values()) {
				const trialId = work.startTrial({
					runId,
					caseId: resolution.evalCase.id,
					condition: "triage",
					attempt: 1,
					phase: "triage",
				});
				if (resolution.result)
					work.recordModelCall(trialId, TRIAGE_PURPOSE, resolution.result);
				if (resolution.state === "concluded")
					work.finishTrial(trialId, {
						status: "completed",
						outputText: resolution.result?.ok
							? resolution.result.text
							: undefined,
					});
				else if (resolution.state === "missing")
					work.finishTrial(trialId, {
						status: "interrupted",
						error: resolution.error,
					});
				else
					work.finishTrial(trialId, {
						status: "failed",
						error: resolution.error,
					});
			}
		}
		// Record the enumeration calls as this run's trials (phase `enum`, one per case).
		if (options.staged) {
			for (const resolution of enumResolutions.values()) {
				const trialId = work.startTrial({
					runId,
					caseId: resolution.evalCase.id,
					condition: "enum",
					attempt: 1,
					phase: "enum",
				});
				if (resolution.result)
					work.recordModelCall(trialId, ENUM_PURPOSE, resolution.result);
				if (resolution.state === "concluded")
					work.finishTrial(trialId, {
						status: "completed",
						outputText: resolution.result?.ok
							? resolution.result.text
							: undefined,
					});
				else if (resolution.state === "missing")
					work.finishTrial(trialId, {
						status: "interrupted",
						error: resolution.error,
					});
				else
					work.finishTrial(trialId, {
						status: "failed",
						error: resolution.error,
					});
			}
		}
		const { inference, files } = composeRecordings;
		for (const cell of prepared) {
			const blocked = cell.triageBlocked ?? cell.enumBlocked;
			if (blocked) {
				// No usable pre-pass conclusion: the composing cell is blocked, recorded
				// as its own interrupted/failed trial, never silently composed.
				const trialId = work.startTrial({
					runId,
					caseId: cell.evalCase.id,
					condition: cell.format,
					attempt: 1,
					phase: "compose",
				});
				work.finishTrial(trialId, {
					status: blocked.status === "missing" ? "interrupted" : "failed",
					error: blocked.error,
				});
				cells.push({
					caseId: cell.evalCase.id,
					format: cell.format,
					fixtureDependent: cell.evalCase.usesFixtureContracts,
					status: blocked.status,
					promptTokens: cell.promptTokens,
					outputTokens: null,
				});
				continue;
			}
			const report = await runCell({
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
				restoreSyntax: options.restoreSyntax === true,
				normalizeIds: options.normalizeIds === true,
				hostReading: hostPrompt !== undefined,
				...(cell.enumConclusion
					? { enumItems: cell.enumConclusion.items }
					: {}),
			});
			if (cell.triageConclusion)
				report.triage = {
					verdict: cell.triageConclusion.verdict,
					questions: cell.triageConclusion.questions,
				};
			cells.push(report);
		}
		if (options.repair || options.coverageRepair) {
			const repairRecordings =
				preparedRepairRecordings ??
				RecordedInference.fromDirectory(repairRecordingsDir);
			for (const [index, cell] of prepared.entries()) {
				await runRepair({
					preparedRequests,
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
					restoreSyntax: options.restoreSyntax === true,
					normalizeIds: options.normalizeIds === true,
					mechanicalRepair: options.repair === true,
					coverageRepair: options.coverageRepair === true,
					cellKey: cellKey({ caseId: cell.evalCase.id, format: cell.format }),
				});
			}
		}
		if (frozen)
			recordPreparedRequests(work, {
				session: options.session,
				freezeDigest: frozen.digest,
				requests: preparedRequests,
				parentRunId: runId,
			});
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
	if (options.repair || options.coverageRepair) {
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
	// Restore totals over the composing attempts (the evaluations map holds those
	// only; repair attempts carry their own per-cell flag instead).
	let restoreSummary: FormatRestoreSummary | undefined;
	if (options.restoreSyntax) {
		const attempts = [...evaluations.values()];
		restoreSummary = {
			attempted: attempts.filter((a) => a.restoreAttempted).length,
			recovered: attempts.filter((a) => a.syntaxRestored).length,
		};
	}
	// Normalization totals, likewise over the composing attempts only.
	let normalizeSummary: FormatNormalizeSummary | undefined;
	if (options.normalizeIds) {
		const attempts = [...evaluations.values()];
		normalizeSummary = {
			attempted: attempts.filter((a) => a.normalizeAttempted).length,
			recovered: attempts.filter((a) => a.idsNormalized).length,
		};
	}
	// Triage totals over the per-case resolutions, with the calls' token cost
	// counted the same way as the composing traffic (null where uncountable).
	let triageSummary: FormatTriageSummary | undefined;
	if (options.triage) {
		const resolutions = [...triageResolutions.values()];
		const sumOrNull = (values: (number | null)[]) =>
			values.some((v) => v === null)
				? null
				: values.reduce<number>((a, v) => a + (v ?? 0), 0);
		const triagePromptCounts = countTokens(
			resolutions.map((r) => `${r.system}\n${r.prompt}`),
		);
		const withOutput = resolutions.filter((r) => r.result?.ok);
		const triageOutputCounts = countTokens(
			withOutput.map((r) => (r.result?.ok ? r.result.text : "")),
		);
		triageSummary = {
			cases: resolutions.length,
			concluded: resolutions.filter((r) => r.state === "concluded").length,
			proceed: resolutions.filter((r) => r.conclusion?.verdict === "proceed")
				.length,
			needsInput: resolutions.filter(
				(r) => r.conclusion?.verdict === "needs_input",
			).length,
			missing: resolutions.filter((r) => r.state === "missing").length,
			digestMismatch: resolutions.filter((r) => r.state === "digest-mismatch")
				.length,
			invalid: resolutions.filter((r) => r.state === "invalid").length,
			promptTokens: sumOrNull(triagePromptCounts),
			outputTokens: withOutput.length === 0 ? 0 : sumOrNull(triageOutputCounts),
		};
	}
	// Enumeration totals over the per-case resolutions, counted like triage's.
	let enumSummary: FormatEnumSummary | undefined;
	if (options.staged) {
		const resolutions = [...enumResolutions.values()];
		const sumOrNull = (values: (number | null)[]) =>
			values.some((v) => v === null)
				? null
				: values.reduce<number>((a, v) => a + (v ?? 0), 0);
		const enumPromptCounts = countTokens(
			resolutions.map((r) => `${r.system}\n${r.prompt}`),
		);
		const withOutput = resolutions.filter((r) => r.result?.ok);
		const enumOutputCounts = countTokens(
			withOutput.map((r) => (r.result?.ok ? r.result.text : "")),
		);
		enumSummary = {
			cases: resolutions.length,
			concluded: resolutions.filter((r) => r.state === "concluded").length,
			missing: resolutions.filter((r) => r.state === "missing").length,
			digestMismatch: resolutions.filter((r) => r.state === "digest-mismatch")
				.length,
			invalid: resolutions.filter((r) => r.state === "invalid").length,
			items: resolutions.reduce(
				(a, r) => a + (r.conclusion?.items.length ?? 0),
				0,
			),
			promptTokens: sumOrNull(enumPromptCounts),
			outputTokens: withOutput.length === 0 ? 0 : sumOrNull(enumOutputCounts),
		};
	}
	const report: FormatRunReport = {
		runId,
		sessionDir,
		condition: conditionInfo,
		tokenizer: provenance,
		cells,
		byFormat,
		totals,
		...(repairSummary ? { repair: repairSummary } : {}),
		...(restoreSummary ? { restore: restoreSummary } : {}),
		...(normalizeSummary ? { normalize: normalizeSummary } : {}),
		...(triageSummary ? { triage: triageSummary } : {}),
		...(enumSummary ? { staged: enumSummary } : {}),
	};
	writeFileSync(
		join(sessionDir, "summary.json"),
		`${JSON.stringify(
			{
				runId,
				condition: conditionInfo,
				conditionDefinition: condition,
				tokenizer: provenance,
				byFormat,
				totals,
				...(repairSummary ? { repair: repairSummary } : {}),
				...(restoreSummary ? { restore: restoreSummary } : {}),
				...(normalizeSummary ? { normalize: normalizeSummary } : {}),
				...(triageSummary ? { triage: triageSummary } : {}),
				...(enumSummary ? { staged: enumSummary } : {}),
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
					...(cell.syntaxRestored !== undefined
						? { syntaxRestored: cell.syntaxRestored }
						: {}),
					...(cell.idsNormalized !== undefined
						? { idsNormalized: cell.idsNormalized }
						: {}),
					...(cell.triage ? { triage: cell.triage } : {}),
					...(cell.coverage ? { coverage: cell.coverage } : {}),
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
	/** Offer the syntax-restore stage to failed strict parses (restore runs only). */
	restoreSyntax: boolean;
	/** Offer the step-id normalization stage to id-only authoring failures (normalization runs only). */
	normalizeIds: boolean;
	/** Read the output as the host does (host-prompt condition): see `evaluateAttempt`. */
	hostReading: boolean;
	/** The case's stage-A items (staged runs, concluded cases). */
	enumItems?: readonly WorkItem[];
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
	/** Offer the deterministic syntax-restore stage to a failed strict parse (`json` only). */
	restoreSyntax: boolean;
	/** Offer the deterministic step-id normalization stage to an id-only authoring failure. */
	normalizeIds: boolean;
	/**
	 * Read the output as Eumenes does (host-prompt condition): the strict reader on the raw text
	 * (no trimming), an explicit `status` required, and the original request bound before the
	 * check, a differing copy recorded as a non-blocking `request_mismatch` warning.
	 */
	hostReading?: boolean;
	/**
	 * The case's stage-A items (staged runs). When present and the parse is a
	 * ready outcome, coverage is computed from the raw parse and the markers are
	 * stripped from the definition every later stage sees.
	 */
	enumItems?: readonly WorkItem[];
}): Promise<EvaluatedAttempt> {
	const { evalCase, format } = ctx;
	let parse: ParseResult;
	let restoreAttempted = false;
	let syntaxRestored = false;
	if (ctx.restoreSyntax && format === "json") {
		const composed = parseJsonWithRestore(ctx.text);
		parse = composed.result;
		restoreAttempted = composed.attempted;
		syntaxRestored = composed.restored;
	} else if (ctx.hostReading) {
		parse = parseHostOutput(ctx.text);
	} else {
		parse = FORMAT_PARSERS[format](ctx.text);
	}
	// Stage C's deterministic half: coverage is read off the RAW parse (markers
	// intact), then the markers are stripped — authoring, checking, mock and
	// scoring all see the plain definition, exactly as in a non-staged run.
	let coverage: CoverageResult | undefined;
	if (ctx.enumItems && parse.ok && parse.outcome.kind === "ready") {
		coverage = computeCoverage(ctx.enumItems, parse.outcome.definition);
		parse = {
			ok: true,
			outcome: {
				kind: "ready",
				definition: stripItemMarkers(parse.outcome.definition),
			},
		};
	}
	const {
		outcome: authored,
		issues: authoringIssues,
		normalizeAttempted,
		idsNormalized,
	} = validateAuthoring(parse, { normalizeIds: ctx.normalizeIds });
	const attempt: AttemptResults = { parse };
	let check: CheckResult | undefined;
	if (authored?.status === "ready") {
		const bound = ctx.hostReading
			? bindSourceRequest(authored.definition, evalCase.request)
			: undefined;
		check = checkDefinition(
			bound?.definition ?? authored.definition,
			ctx.catalog.view,
			{ sourceRequest: evalCase.request },
		);
		if (bound && !bound.matched)
			check = {
				...check,
				issues: [
					{
						code: "request_mismatch",
						path: "request",
						message:
							"the model's request differed from the original; bound to the original as the host does",
						severity: "warning",
					},
					...check.issues,
				],
			};
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
		wiring: score.score.wiring,
		delivery: score.score.delivery,
		passed,
	};
	for (const [criterion, value] of Object.entries(breakdown))
		ctx.work.recordScore(ctx.trialId, {
			scorer: FORMAT_SCORER,
			criterion,
			value: value ? 1 : 0,
			...(criterion === "passed" ? { rationale: canonicalJson(score) } : {}),
		});
	// Restore runs record the restore fact as its own criterion, apart from the
	// verdict criteria, so a reader can separate the raw parse rate from the
	// restored one. Non-restore runs record nothing extra (pre-restore shape).
	if (ctx.restoreSyntax)
		ctx.work.recordScore(ctx.trialId, {
			scorer: FORMAT_SCORER,
			criterion: "syntax_restored",
			value: syntaxRestored ? 1 : 0,
		});
	// Normalization runs likewise record the normalization fact as its own
	// criterion, so the raw authoring rate stays separable from the normalized one.
	if (ctx.normalizeIds)
		ctx.work.recordScore(ctx.trialId, {
			scorer: FORMAT_SCORER,
			criterion: "ids_normalized",
			value: idsNormalized ? 1 : 0,
		});
	return {
		parse,
		authored,
		authoringIssues,
		...(check ? { check } : {}),
		score,
		passed,
		restoreAttempted,
		syntaxRestored,
		normalizeAttempted,
		idsNormalized,
		...(coverage ? { coverage } : {}),
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
		restoreSyntax: ctx.restoreSyntax,
		normalizeIds: ctx.normalizeIds,
		hostReading: ctx.hostReading,
		...(ctx.enumItems ? { enumItems: ctx.enumItems } : {}),
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
		...(ctx.restoreSyntax ? { syntaxRestored: evaluated.syntaxRestored } : {}),
		...(ctx.normalizeIds ? { idsNormalized: evaluated.idsNormalized } : {}),
		...(evaluated.coverage
			? {
					coverage: {
						total: evaluated.coverage.total,
						covered: evaluated.coverage.coveredIds.length,
						uncovered: evaluated.coverage.uncovered.map((i) => i.id),
					},
				}
			: {}),
	};
}

type RepairContext = {
	preparedRequests: PreparedApiRequest[];
	/** The prepared composing cell (its system + prompt are the repair's raw material). */
	cell: {
		evalCase: EvalCase;
		format: FormatId;
		system: string;
		prompt: string;
		/** The case's stage-A conclusion (staged runs), for coverage evaluation. */
		enumConclusion?: EnumConclusion;
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
	/** Offer the syntax-restore stage to the repair attempt's parse as well. */
	restoreSyntax: boolean;
	/** Offer the step-id normalization stage to the repair attempt's authoring gate as well. */
	normalizeIds: boolean;
	/** The mechanical repair round is enabled (parse / authoring / check failures). */
	mechanicalRepair: boolean;
	/** The coverage review round is enabled (stage C; mechanically sound staged cells only). */
	coverageRepair: boolean;
	cellKey: string;
};

/**
 * The one repair round of one cell. A cell is eligible only when its composing
 * attempt was scored AND either failed mechanically (the mechanical round) or —
 * in staged runs with the coverage review on — is mechanically sound but leaves
 * enumerated items uncovered (the coverage round); anything else returns
 * without touching the report. The two classes never share a cell's one round:
 * mechanical failure takes the round when its class is enabled, and a
 * mechanically failed cell is never coverage-repaired. The repair is recorded
 * as its own trial (attempt 2, phase `repair`) and its output runs the same
 * evaluator path as a composing output.
 */
async function runRepair(ctx: RepairContext): Promise<void> {
	const { evalCase, format } = ctx.cell;
	const evaluated = ctx.evaluations.get(ctx.cellKey);
	const original = ctx.outputs.get(ctx.cellKey);
	if (!evaluated || original === undefined) return;
	const mechanical = machineErrorLines(evaluated);
	let built: { system: string; prompt: string };
	if (mechanical && ctx.mechanicalRepair) {
		built = buildRepairPrompt({
			system: ctx.cell.system,
			prompt: ctx.cell.prompt,
			output: original,
			errors: mechanical,
		});
	} else if (
		!mechanical &&
		ctx.coverageRepair &&
		evaluated.coverage &&
		evaluated.coverage.uncovered.length > 0
	) {
		built = buildCoverageRepairPrompt({
			system: ctx.cell.system,
			prompt: ctx.cell.prompt,
			output: original,
			errors: evaluated.coverage.uncovered.map(coverageErrorLine),
		});
	} else return;
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
	ctx.preparedRequests.push({
		phase: "repair",
		name: fileName,
		promptDigest: digest,
	});
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
		restoreSyntax: ctx.restoreSyntax,
		normalizeIds: ctx.normalizeIds,
		...(ctx.cell.enumConclusion
			? { enumItems: ctx.cell.enumConclusion.items }
			: {}),
	});
	if (ctx.restoreSyntax) repair.syntaxRestored = after.syntaxRestored;
	if (ctx.normalizeIds) repair.idsNormalized = after.idsNormalized;
	if (after.coverage)
		repair.coverageAfter = {
			total: after.coverage.total,
			covered: after.coverage.coveredIds.length,
		};
	ctx.work.finishTrial(trialId, {
		status: "completed",
		outputText: result.text,
	});
	repair.status = "scored";
	repair.after = verdictOf(after, after.authored !== null);
}
