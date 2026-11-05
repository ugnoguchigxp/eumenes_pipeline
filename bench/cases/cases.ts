/**
 * Evaluation cases (plan §9, §10 P0c): a user request, the materials handed over with it, and the
 * gold outcome an evaluator compares an authored attempt against.
 *
 * FAIRNESS (plan §9): `expected` is gold. Only the evaluator, the scorer and tests may read it.
 * Nothing in here is ever rendered into a composing-side input (prompts, card listings, parser
 * input) or passed to the mock host; the mock answers from the chosen entry's contract alone.
 *
 * Conventions fixed for the bench:
 * - One JSON file per case in `data/cases/`, named `<id>.json`. The loader reads them in file-name
 *   order and rejects duplicate ids and malformed files: a broken case set fails loudly, never
 *   silently shrinks the denominator.
 * - `requiredBundles` / `acceptableBundles` name offered ENTRY ids (not bundle ids): the entry is
 *   what a step resolves to. `requiredMaterials` names the materials that must be wired into a
 *   later step's `from` or the output's `from`: `"request"` (the original request) or an entry id,
 *   naming the material by the entry whose step produces it (step ids are the author's choice, so
 *   gold cannot name them). Name materials after `requiredBundles` entries.
 * - Materials the user hands over (`providedMaterials`) ride with the `request` reference: a step
 *   consumes them by taking `from: ["request"]`. They are composing-side context, never gold
 *   wiring targets.
 * - `expected.finalArtifact` names the `kind` of a fixture artifact value expected among the
 *   run's adopted outputs (`"image"`, `"music"`; see `data/contracts/fixture-outputs.json`).
 * - `usesFixtureContracts` is true exactly when an acceptable solution needs a legacy (unbound)
 *   entry or an entry whose output contract is a bench fixture. Results on those cases are
 *   reported apart from catalog-only cases (plan §4); the loader test recomputes the flag from
 *   the catalog and fails on a mismatch.
 * - `split` is required on every case (a file without it fails loudly; there is no default):
 *   `"dev"` cases may be looked at while tuning formats, prompts and thresholds; `"holdout"`
 *   cases are the protected evaluation set and are never used for tuning (plan §9). The seed
 *   cases from P0c are all `"dev"` — the P0d measurements already decided on them.
 * - `group` names a family of near-duplicate requests (same conversation, paraphrase, or a
 *   pair whose materials/targets are easily swapped). A group never spans splits: similar
 *   requests must not leak across the dev/holdout boundary (plan §9).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { byCodeUnit } from "../../src/catalog.ts";
import { ENTRY_PATTERN } from "../../src/contracts/component.ts";
import { wiringAlternative } from "../scoring/wiring.ts";

export const DEFAULT_CASES_DIR = "data/cases";

const entryId = z.string().regex(ENTRY_PATTERN);

export const evalCase = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
	/** The user's request, verbatim. The only part of a case the composing side ever sees. */
	request: z.string().min(1).max(8000),
	/** Materials the user hands over together with the request (rides with the request reference). */
	providedMaterials: z
		.array(
			z.strictObject({
				name: z.string().min(1).max(100),
				kind: z.string().min(1).max(100),
			}),
		)
		.max(8),
	expected: z.strictObject({
		kind: z.enum(["pipeline", "needs_input", "unsupported"]),
		/** Entries a correct definition must use. */
		requiredBundles: z.array(entryId).max(8).optional(),
		/** Entries a correct definition may use in addition to the required ones (never instead of one). */
		acceptableBundles: z.array(entryId).max(8).optional(),
		/** Materials (entry ids or `"request"`) whose results must reach a later step or the output. */
		requiredMaterials: z.array(z.string().min(1).max(100)).max(9).optional(),
		/** The fixture artifact `kind` expected among the adopted outputs. */
		finalArtifact: z.string().min(1).max(100).optional(),
		/** Evaluator-only valid role/dependency/delivery alternatives; not producer input. */
		wiringAlternatives: z.array(wiringAlternative).min(1).max(8).optional(),
	}),
	/** True when an acceptable solution depends on legacy entries or bench fixture contracts. */
	usesFixtureContracts: z.boolean(),
	/** Which side of the dev/holdout boundary this case sits on (plan §9). Always explicit. */
	split: z.enum(["dev", "holdout"]),
	/** Near-duplicate family this case belongs to, if any. A group never spans splits. */
	group: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,59}$/)
		.optional(),
	notes: z.string().min(1).max(1000).optional(),
});
export type EvalCase = z.infer<typeof evalCase>;

/** Load and validate every case in `dir` (default `data/cases/`), in file-name order. */
export function loadCases(dir: string = DEFAULT_CASES_DIR): EvalCase[] {
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort(byCodeUnit);
	const cases: EvalCase[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const path = join(dir, file);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new Error(`${path}: not valid JSON: ${String(error)}`);
		}
		const parsed = evalCase.safeParse(raw);
		if (!parsed.success)
			throw new Error(
				`${path}: invalid case: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
			);
		if (seen.has(parsed.data.id))
			throw new Error(`${path}: duplicate case id "${parsed.data.id}"`);
		seen.add(parsed.data.id);
		cases.push(parsed.data);
	}
	return cases;
}
