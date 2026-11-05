/**
 * The scorer (plan §9, §10 P0c): compares one authored attempt against a case's gold and returns
 * a structured, deterministic record. It judges only structure the code can prove — state,
 * resolution, wiring, mock completion — never whether a step's prose fulfils the request (that
 * is the semantic evaluation's job, kept separate).
 *
 * Fixed scoring rules:
 * - State first: `stateMatch` compares the authored outcome (ready = "pipeline") with
 *   `expected.kind`. A wrong state fails the case whatever else matches.
 * - Bundles: chosen entries come from the checked plan when there is one, else from resolving
 *   the raw parsed definition. `acceptableExtra` lists chosen entries outside
 *   `requiredBundles ∪ acceptableBundles` — but only when the case constrains the choice at
 *   all (either list present); an unconstrained case never punishes extra entries here.
 * - Materials: a required material is wired when it reaches a later step's `from` or the
 *   output's `from`. Materials are named per the case convention (`bench/cases/cases.ts`):
 *   `"request"`, or the producing entry's id.
 * - Mock completion requires a finished run with every step adopted. The mock's completed
 *   outputs are synthesized from the chosen entries' OWN contracts (the current bench
 *   assumption, see `bench/mock/host.ts`): scoring therefore checks that the names a later
 *   step references are wired correctly, and never assumes a receipt-shaped value is what a
 *   later step receives (P0a: a job-type entry's completed output is a domain record whose
 *   schema is not in the catalog).
 * - `finalArtifactMatch` is null when the case names no artifact; otherwise it requires an
 *   adopted step output whose `kind` equals the expected one.
 * - The breakdown booleans are the verdict per aspect; `passed` is their conjunction. There is
 *   deliberately no single numeric total to optimize against.
 */
import type { CatalogView } from "../../src/catalog.ts";
import { REQUEST_REF } from "../../src/contracts/definition.ts";
import type { EvalCase } from "../cases/cases.ts";
import type { AttemptResults } from "./evaluate.ts";
import { matchesWiring } from "./wiring.ts";

export type ScoreBreakdown = {
	/** Parsed, and (for a ready outcome) passed `checkDefinition`. */
	structure: boolean;
	state: boolean;
	bundles: boolean;
	materials: boolean;
	/** Mock run completed (pipeline cases), or correctly never executed (other states). */
	execution: boolean;
	artifact: boolean;
	wiring: boolean;
	delivery: boolean;
	passed: boolean;
};

export type CaseScore = {
	caseId: string;
	/** Echo of the case flag: fixture-dependent results are reported apart (plan §4). */
	fixtureDependent: boolean;
	expectedKind: EvalCase["expected"]["kind"];
	authoredKind: EvalCase["expected"]["kind"] | null;
	parseOk: boolean;
	parseErrors: string[];
	/** Null when the attempt was not a ready definition (nothing to check). */
	checkOk: boolean | null;
	stateMatch: boolean;
	requiredHits: string[];
	requiredMisses: string[];
	acceptableExtra: string[];
	/** Raw `bundle` strings of steps that did not resolve, when no checked plan exists. */
	unresolvedSteps: string[];
	/** Wired share of `requiredMaterials`; null when the case requires none. */
	materialsWired: number | null;
	materialsMissing: string[];
	/** Null when no mock run was attempted. */
	mockCompleted: boolean | null;
	finalArtifactMatch: boolean | null;
	finalArtifactDelivered: boolean | null;
	wiringMatch: boolean | null;
	score: ScoreBreakdown;
};

type StepChoice = { id: string; entry: string | null; from: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];

function choicesFromRaw(
	definition: unknown,
	view: CatalogView,
): { steps: StepChoice[]; outputFrom: string[]; unresolved: string[] } {
	const steps: StepChoice[] = [];
	const unresolved: string[] = [];
	if (!isRecord(definition) || !Array.isArray(definition.steps))
		return { steps, outputFrom: [], unresolved };
	for (const raw of definition.steps) {
		if (
			!isRecord(raw) ||
			typeof raw.id !== "string" ||
			typeof raw.bundle !== "string"
		)
			continue;
		const resolved = view.resolve(
			raw.bundle,
			typeof raw.entry === "string" ? raw.entry : undefined,
		);
		if (!resolved.ok) unresolved.push(raw.bundle);
		steps.push({
			id: raw.id,
			entry: resolved.ok ? resolved.record.card.entry : null,
			from: stringList(raw.from),
		});
	}
	const outputFrom = isRecord(definition.output)
		? stringList(definition.output.from)
		: [];
	return { steps, outputFrom, unresolved };
}

export function scoreCase(
	evalCase: EvalCase,
	attempt: AttemptResults,
	view: CatalogView,
): CaseScore {
	const { expected } = evalCase;
	const parse = attempt.parse;
	const parseOk = parse.ok;
	const authoredKind: CaseScore["authoredKind"] = !parse.ok
		? null
		: parse.outcome.kind === "ready"
			? "pipeline"
			: parse.outcome.kind;
	const stateMatch = authoredKind !== null && authoredKind === expected.kind;
	const checkOk =
		authoredKind === "pipeline" && attempt.check ? attempt.check.ok : null;

	let steps: StepChoice[] = [];
	let outputFrom: string[] = [];
	let unresolvedSteps: string[] = [];
	if (attempt.check?.ok) {
		steps = attempt.check.plan.steps.map((s) => ({
			id: s.stepId,
			entry: s.entry,
			from: s.from,
		}));
		outputFrom = attempt.check.plan.output.from;
	} else if (parse.ok && parse.outcome.kind === "ready") {
		const raw = choicesFromRaw(parse.outcome.definition, view);
		steps = raw.steps;
		outputFrom = raw.outputFrom;
		unresolvedSteps = raw.unresolved;
	}

	const chosen = [...new Set(steps.flatMap((s) => (s.entry ? [s.entry] : [])))];
	const required = expected.requiredBundles ?? [];
	const requiredHits = required.filter((e) => chosen.includes(e));
	const requiredMisses = required.filter((e) => !chosen.includes(e));
	const constrained =
		expected.requiredBundles !== undefined ||
		expected.acceptableBundles !== undefined;
	const allowed = new Set([...required, ...(expected.acceptableBundles ?? [])]);
	const acceptableExtra = constrained
		? chosen.filter((e) => !allowed.has(e))
		: [];

	const allFroms = steps.flatMap((s) => s.from);
	const materialsMissing: string[] = [];
	for (const name of expected.requiredMaterials ?? []) {
		const wired =
			name === REQUEST_REF
				? allFroms.includes(REQUEST_REF) || outputFrom.includes(REQUEST_REF)
				: steps
						.filter((s) => s.entry === name)
						.some(
							(producer) =>
								steps.some(
									(o) => o.id !== producer.id && o.from.includes(producer.id),
								) || outputFrom.includes(producer.id),
						);
		if (!wired) materialsMissing.push(name);
	}
	const requiredMaterialCount = (expected.requiredMaterials ?? []).length;
	const materialsWired =
		requiredMaterialCount === 0
			? null
			: (requiredMaterialCount - materialsMissing.length) /
				requiredMaterialCount;

	const run = attempt.run;
	const mockCompleted = run
		? run.status === "completed" &&
			run.steps.length > 0 &&
			run.steps.every((s) => s.adopted)
		: null;

	const finalArtifactMatch =
		expected.finalArtifact === undefined
			? null
			: run !== undefined &&
				run.status === "completed" &&
				run.steps.some(
					(s) =>
						s.adopted &&
						isRecord(s.result.output) &&
						s.result.output.kind === expected.finalArtifact,
				);
	const delivered = run?.delivered ?? [];
	const finalArtifactDelivered =
		expected.finalArtifact === undefined
			? null
			: (run?.steps.some(
					(step) =>
						step.adopted &&
						isRecord(step.result.output) &&
						step.result.output.kind === expected.finalArtifact &&
						delivered.some(
							(d) => d.from === step.stepId && d.references.length > 0,
						),
				) ?? false);
	const wiringMatch =
		expected.wiringAlternatives === undefined
			? null
			: matchesWiring(
					steps,
					delivered.map((d) => d.from),
					expected.wiringAlternatives,
				);

	const score: ScoreBreakdown = {
		structure: parseOk && (authoredKind !== "pipeline" || checkOk === true),
		state: stateMatch,
		bundles: requiredMisses.length === 0 && acceptableExtra.length === 0,
		materials: materialsWired === null || materialsWired === 1,
		execution:
			expected.kind === "pipeline" ? mockCompleted === true : run === undefined,
		artifact: finalArtifactMatch !== false,
		wiring: wiringMatch !== false,
		delivery: finalArtifactDelivered !== false,
		passed: false,
	};
	score.passed =
		score.structure &&
		score.state &&
		score.bundles &&
		score.materials &&
		score.execution &&
		score.artifact &&
		score.wiring &&
		score.delivery;

	return {
		caseId: evalCase.id,
		fixtureDependent: evalCase.usesFixtureContracts,
		expectedKind: expected.kind,
		authoredKind,
		parseOk,
		parseErrors: parse.ok ? [] : parse.errors.map((e) => e.code),
		checkOk,
		stateMatch,
		requiredHits,
		requiredMisses,
		acceptableExtra,
		unresolvedSteps,
		materialsWired,
		materialsMissing,
		mockCompleted,
		finalArtifactMatch,
		finalArtifactDelivered,
		wiringMatch,
		score,
	};
}
