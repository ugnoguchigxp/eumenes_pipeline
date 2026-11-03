/**
 * Deterministic step-id normalization (opt-in bench stage, accuracy follow-up 1):
 * the single largest mechanical failure class of the compose path is a step id that
 * violates the contract's id pattern (`/^[a-z][a-z0-9-]{0,39}$/` — snake_case ids
 * above all) in an otherwise valid definition. The repair loop fixes those by
 * spending a model call; this stage rewrites them deterministically instead.
 *
 * The stage sits at the authoring gate (`AuthoringOutcome` validation) and fires
 * ONLY when a parsed `ready` outcome fails that gate and every schema issue is a
 * step-id pattern issue — nothing else about the definition is ever touched:
 * - ids that already satisfy the pattern are kept verbatim;
 * - an offending id is rewritten by `normalizeStepId` (case, separators, leading
 *   character, length — shape only, never meaning);
 * - references follow the mapping (`steps[].from`, `output.from`); references
 *   that are not step ids (`request`, or names checkDefinition will judge) are
 *   left exactly as written;
 * - the rewrite must be injective over the definition's final id set: if two ids
 *   would land on the same normalized form, or a rewritten id would land on the
 *   reserved `request` reference, normalization is refused and the original
 *   authoring failure stands, errors unchanged.
 *
 * A definition recovered this way still runs every later gate (checkDefinition,
 * mock, scoring) untouched. Callers record per attempt whether normalization was
 * offered and whether it recovered the authoring gate, so the raw authoring rate
 * stays separable. Off by default: a run without the stage is byte-for-byte the
 * pre-normalization bench.
 */
import {
	authoringOutcome,
	type AuthoringOutcome,
} from "../../src/contracts/authoring.ts";
import { REQUEST_REF } from "../../src/contracts/definition.ts";
import type { ParseResult } from "./outcome.ts";

/** The normalization rule recorded in a run's config when the stage is enabled. */
export const ID_NORMALIZE_VERSION = "step-id-normalize-v1";

/** The contract's step-id pattern (src/contracts/definition.ts), restated for the gate. */
const STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The canonical form of one offending step id. Shape only: lowercase, runs of
 * characters outside `[a-z0-9]` collapse to one hyphen, no leading/trailing
 * hyphen, a leading letter is guaranteed, and the result fits the pattern's
 * 40-character bound. An id with no usable characters at all becomes `step`.
 */
export function normalizeStepId(raw: string): string {
	let s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	s = s.replace(/^-+|-+$/g, "");
	if (s === "") s = "step";
	if (!/^[a-z]/.test(s)) s = `s-${s}`;
	if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, "");
	return s;
}

export type IdNormalization = {
	/** The definition with ids and their references rewritten; content otherwise identical. */
	definition: unknown;
	/** The ids that changed: original → normalized. Unchanged ids are absent. */
	mapping: ReadonlyMap<string, string>;
};

/**
 * Rewrite a parsed definition's offending step ids (and the references to them)
 * into the contract's id shape. Returns null when the rewrite is impossible or
 * unsafe: the value is not definition-shaped, no id needs rewriting, a rewritten
 * id would collide with another step's final id or with the reserved `request`
 * reference, or a rewritten id still violates the pattern.
 */
export function normalizeDefinitionIds(
	definition: unknown,
): IdNormalization | null {
	if (!isRecord(definition) || !Array.isArray(definition.steps)) return null;
	const steps: unknown[] = definition.steps;
	const originals: string[] = [];
	for (const step of steps) {
		if (!isRecord(step) || typeof step.id !== "string") return null;
		originals.push(step.id);
	}
	const finals = originals.map((id) =>
		STEP_ID_PATTERN.test(id) ? id : normalizeStepId(id),
	);
	const mapping = new Map<string, string>();
	originals.forEach((id, i) => {
		const to = finals[i] as string;
		if (to !== id) mapping.set(id, to);
	});
	if (mapping.size === 0) return null;
	// Injectivity over the final id set, and no rewritten id may become the
	// reserved request reference (an untouched step literally named `request`
	// is the checker's problem, not this stage's — but creating one is ours).
	if (new Set(finals).size !== finals.length) return null;
	for (const to of mapping.values()) if (to === REQUEST_REF) return null;
	for (const to of finals) if (!STEP_ID_PATTERN.test(to)) return null;

	const cloned = structuredClone(definition) as Record<string, unknown>;
	const clonedSteps = cloned.steps as Record<string, unknown>[];
	const rewriteRefs = (refs: unknown): void => {
		if (!Array.isArray(refs)) return;
		for (let i = 0; i < refs.length; i++) {
			const ref = refs[i];
			if (typeof ref === "string" && mapping.has(ref))
				refs[i] = mapping.get(ref);
		}
	};
	clonedSteps.forEach((step, i) => {
		step.id = finals[i] as string;
		rewriteRefs(step.from);
	});
	if (isRecord(cloned.output)) rewriteRefs(cloned.output.from);
	return { definition: cloned, mapping };
}

export type AuthoringGateResult = {
	/** The validated outcome; null when the authoring gate failed. */
	outcome: AuthoringOutcome | null;
	/** The FIRST gate failure's issues (path + message, verbatim); empty on success. */
	issues: string[];
	/** The gate failed on step-id shape alone and normalization was attempted. */
	normalizeAttempted: boolean;
	/** Normalization rewrote the ids and the rewritten definition passed the gate. */
	idsNormalized: boolean;
};

type RawGate = {
	outcome: AuthoringOutcome | null;
	issues: string[];
	paths: unknown[][];
	candidate: Record<string, unknown> | null;
};

function rawGate(parse: ParseResult): RawGate {
	if (!parse.ok)
		return { outcome: null, issues: [], paths: [], candidate: null };
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
	if (parsed.success)
		return { outcome: parsed.data, issues: [], paths: [], candidate };
	return {
		outcome: null,
		issues: parsed.error.issues.map(
			(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
		),
		paths: parsed.error.issues.map((issue) => [...issue.path]),
		candidate,
	};
}

const isStepIdPath = (path: unknown[]): boolean =>
	path.length === 4 &&
	path[0] === "definition" &&
	path[1] === "steps" &&
	typeof path[2] === "number" &&
	path[3] === "id";

/**
 * The authoring gate of one parsed output, with the optional normalization stage.
 * With `normalizeIds: false` this is exactly the pre-normalization gate. With it,
 * a `ready` outcome that fails ONLY on step-id shape gets one deterministic
 * rewrite and one re-validation; on any doubt the original failure — its issues
 * included — stands unchanged.
 */
export function validateAuthoring(
	parse: ParseResult,
	options: { normalizeIds: boolean },
): AuthoringGateResult {
	const first = rawGate(parse);
	if (first.outcome)
		return {
			outcome: first.outcome,
			issues: [],
			normalizeAttempted: false,
			idsNormalized: false,
		};
	if (
		!options.normalizeIds ||
		!parse.ok ||
		parse.outcome.kind !== "ready" ||
		!first.candidate ||
		first.paths.length === 0 ||
		!first.paths.every(isStepIdPath)
	)
		return {
			outcome: null,
			issues: first.issues,
			normalizeAttempted: false,
			idsNormalized: false,
		};
	const normalized = normalizeDefinitionIds(first.candidate.definition);
	if (!normalized)
		return {
			outcome: null,
			issues: first.issues,
			normalizeAttempted: true,
			idsNormalized: false,
		};
	const second = authoringOutcome.safeParse({
		status: "ready",
		definition: normalized.definition,
	});
	if (second.success && second.data.status === "ready")
		return {
			outcome: second.data,
			issues: [],
			normalizeAttempted: true,
			idsNormalized: true,
		};
	return {
		outcome: null,
		issues: first.issues,
		normalizeAttempted: true,
		idsNormalized: false,
	};
}
