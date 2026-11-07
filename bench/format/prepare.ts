/** Input validation and model-visible request preparation for the recorded runner. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, DEFAULT_CASES_DIR, type EvalCase } from "../cases/cases.ts";
import { verifyFreeze } from "../cases/freeze.ts";
import { FORMAT_IDS, type FormatId } from "../formats/index.ts";
import { DEFAULT_ATTEMPT_SEED } from "../scoring/evaluate.ts";
import {
	RecordedInference,
	TRIAGE_PURPOSE,
	ENUM_PURPOSE,
} from "../infer/recorded.ts";
import { countTokens, tokenizerProvenance } from "../tokens.ts";
import {
	BASELINE_CONDITION,
	summarizeCondition,
	WORKED_EXAMPLES,
	type FormatCondition,
} from "./conditions.ts";
import {
	buildHostPrompt,
	loadHostPrompt,
	hostPromptIdentity,
} from "./host-prompt.ts";
import { buildFormatPrompt, GUIDANCE_TEXTS } from "./prompt.ts";
import {
	buildEnumPrompt,
	enumNoteText,
	parseEnumOutput,
	type EnumConclusion,
} from "./enumerate.ts";
import {
	buildTriagePrompt,
	triageNoteText,
	parseTriageOutput,
	type TriageConclusion,
} from "./triage.ts";
import { resolvePrePass, type PrePassResolution } from "./recorded-call.ts";
import type { FormatRunOptions, FormatCellStatus } from "./run.ts";

export const DEFAULT_RUNS_ROOT = "data/runs/format";
const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type PreparedCell = {
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

export function prepareRunInputs(options: FormatRunOptions) {
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
		condition.promptStyle === "eumenes-p0-3"
			? loadHostPrompt(options.hostPromptPath, options.hostToolchainRevisionId)
			: undefined;
	if (
		!hostPrompt &&
		(options.hostPromptPath || options.hostToolchainRevisionId)
	)
		throw new Error("host prompt options require the eumenes prompt style");
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
	const hostIdentity = hostPrompt ? hostPromptIdentity(hostPrompt) : undefined;
	if (frozen) {
		const method = {
			condition,
			formats,
			repair: !!options.repair,
			restoreSyntax: !!options.restoreSyntax,
			normalizeIds: !!options.normalizeIds,
			triage: !!options.triage,
			staged: !!options.staged,
			coverageRepair: !!options.coverageRepair,
			candidates: options.candidates ?? null,
			...(hostIdentity ? { hostPrompt: hostIdentity } : {}),
		};
		if (canonicalJson(method) !== canonicalJson(frozen.protocol.formatMethod))
			throw new Error("format method differs from frozen protocol");
	}
	const conditionInfo = {
		...summarizeCondition(condition, options.candidates !== undefined),
		...(hostIdentity ? { hostPrompt: hostIdentity } : {}),
	};
	const provenance = tokenizerProvenance();

	return {
		sessionDir,
		requestsDir,
		recordingsDir,
		repairRequestsDir,
		repairRecordingsDir,
		triageRequestsDir,
		triageRecordingsDir,
		enumRequestsDir,
		enumRecordingsDir,
		frozen,
		catalog,
		cases,
		formats,
		seed,
		condition,
		hostPrompt,
		conditionInfo,
		provenance,
	};
}

async function preparePrePasses(
	options: FormatRunOptions,
	input: ReturnType<typeof prepareRunInputs>,
) {
	const {
		cases,
		triageRequestsDir,
		triageRecordingsDir,
		enumRequestsDir,
		enumRecordingsDir,
	} = input;
	// Triage resolution (triage runs only): one recorded call per case, resolved
	// BEFORE the composing prompts are built, because a concluded case's prompt
	// carries the conclusion. The calls are recorded as work-db trials once the
	// run exists (below); here only files and recordings are touched.
	const triageResolutions = new Map<
		string,
		PrePassResolution<EvalCase, TriageConclusion>
	>();
	if (options.triage) {
		const triageRecordings =
			RecordedInference.fromDirectory(triageRecordingsDir);
		for (const evalCase of cases) {
			const built = buildTriagePrompt(evalCase);
			triageResolutions.set(
				evalCase.id,
				await resolvePrePass({
					evalCase,
					files: triageRecordings.files,
					complete: (request) => triageRecordings.inference.complete(request),
					request: {
						purpose: TRIAGE_PURPOSE,
						system: built.system,
						prompt: built.prompt,
					},
					requestsDir: triageRequestsDir,
					missingError: (fileName) =>
						`missing triage recording; request written to triage-requests/${fileName}`,
					mismatchPrefix: "triage recording",
					invalidError:
						'triage output is not a verdict document (expected {"verdict": "proceed"} or {"verdict": "needs_input", "questions": [...]})',
					parse: parseTriageOutput,
				}),
			);
		}
	}

	// Enumeration resolution (staged runs only): one recorded call per case,
	// resolved BEFORE the composing prompts are built, because a concluded
	// case's prompt carries the item list. Resolved by the same recorded-call
	// rules as triage; the calls are recorded as work-db trials once the run
	// exists (below).
	const enumResolutions = new Map<
		string,
		PrePassResolution<EvalCase, EnumConclusion>
	>();
	if (options.staged) {
		const enumRecordings = RecordedInference.fromDirectory(enumRecordingsDir);
		for (const evalCase of cases) {
			const built = buildEnumPrompt(evalCase);
			enumResolutions.set(
				evalCase.id,
				await resolvePrePass({
					evalCase,
					files: enumRecordings.files,
					complete: (request) => enumRecordings.inference.complete(request),
					request: {
						purpose: ENUM_PURPOSE,
						system: built.system,
						prompt: built.prompt,
					},
					requestsDir: enumRequestsDir,
					missingError: (fileName) =>
						`missing enumeration recording; request written to enum-requests/${fileName}`,
					mismatchPrefix: "enumeration recording",
					invalidError:
						'enumeration output is not an item list (expected {"items": ["...", ...]})',
					parse: parseEnumOutput,
				}),
			);
		}
	}

	return { triageResolutions, enumResolutions };
}

export async function prepareRunCells(
	options: FormatRunOptions,
	input: ReturnType<typeof prepareRunInputs>,
) {
	const {
		cases,
		formats,
		condition,
		hostPrompt,
		catalog,
		recordingsDir,
		repairRecordingsDir,
	} = input;

	const { triageResolutions, enumResolutions } = await preparePrePasses(
		options,
		input,
	);

	// Build every prompt up front and count them in one batch: the prompt of a cell does
	// not depend on its recording, and one helper call keeps the counting cheap.

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
	return {
		prepared,
		triageResolutions,
		enumResolutions,
		composeRecordings,
		preparedRepairRecordings,
	};
}
