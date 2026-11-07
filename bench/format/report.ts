/** Aggregation and JSON presentation; no inference, database, or execution lifecycle. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FormatId } from "../formats/index.ts";
import type { CaseScore } from "../scoring/score.ts";
import { countTokens } from "../tokens.ts";
import type { FormatCondition } from "./conditions.ts";
import type {
	FormatRunReport,
	FormatGroupSummary,
	FormatRunOptions,
	FormatCellReport,
	FormatRepairSummary,
	FormatRestoreSummary,
	FormatNormalizeSummary,
	FormatTriageSummary,
	FormatEnumSummary,
	EvaluatedAttempt,
} from "./run.ts";
import type { prepareRunInputs, prepareRunCells } from "./prepare.ts";

export const emptyGroup = (): FormatGroupSummary => ({
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

export function addCell(
	group: FormatGroupSummary,
	cell: {
		status: string;
		authoringOk?: boolean | null;
		passed?: boolean | null;
		score?: CaseScore | null;
	},
): void {
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

type SummaryInput = {
	runId: string;
	input: Pick<
		ReturnType<typeof prepareRunInputs>,
		"sessionDir" | "formats" | "conditionInfo" | "provenance"
	>;
	preparedRun: Pick<
		Awaited<ReturnType<typeof prepareRunCells>>,
		"triageResolutions" | "enumResolutions"
	>;
	options: FormatRunOptions;
	cells: FormatCellReport[];
	outputs: Map<string, string>;
	evaluations: Map<string, EvaluatedAttempt>;
	repairPromptTexts: Map<string, string>;
	repairOutputTexts: Map<string, string>;
};
const cellKey = (cell: { caseId: string; format: FormatId }) =>
	`${cell.caseId}\0${cell.format}`;

function summarizeTriage(
	triageResolutions: SummaryInput["preparedRun"]["triageResolutions"],
): FormatTriageSummary {
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
	return {
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

function summarizeEnumeration(
	enumResolutions: SummaryInput["preparedRun"]["enumResolutions"],
): FormatEnumSummary {
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
	return {
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

export function summarizeFormatRun(ctx: SummaryInput): FormatRunReport {
	const {
		runId,
		options,
		cells,
		outputs,
		evaluations,
		repairPromptTexts,
		repairOutputTexts,
	} = ctx;
	const { sessionDir, formats, conditionInfo, provenance } = ctx.input;
	const { triageResolutions, enumResolutions } = ctx.preparedRun;

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
	const triageSummary = options.triage
		? summarizeTriage(triageResolutions)
		: undefined;
	// Enumeration totals over the per-case resolutions, counted like triage's.
	const enumSummary = options.staged
		? summarizeEnumeration(enumResolutions)
		: undefined;
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
	return report;
}

export function writeFormatSummary(
	report: FormatRunReport,
	condition: FormatCondition,
): void {
	const {
		runId,
		sessionDir,
		condition: conditionInfo,
		tokenizer: provenance,
		byFormat,
		totals,
		repair: repairSummary,
		restore: restoreSummary,
		normalize: normalizeSummary,
		triage: triageSummary,
		staged: enumSummary,
		cells,
	} = report;

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
}
