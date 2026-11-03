import { describe, expect, test } from "bun:test";
import {
	normalizeDefinitionIds,
	normalizeStepId,
	validateAuthoring,
} from "./normalize-ids.ts";
import type { ParseResult } from "./outcome.ts";

/**
 * The id-normalization stage (accuracy follow-up 1): deterministic rewriting of
 * step ids that violate the contract pattern, and nothing else. These tests pin
 * the trigger (authoring failure on step-id shape ALONE), the reference
 * rewriting, and the refusals (collisions, the reserved `request` reference,
 * non-id failures, already-valid definitions).
 */
const ready = (definition: unknown): ParseResult => ({
	ok: true,
	outcome: { kind: "ready", definition },
});

const definitionWithIds = (ids: string[]) => ({
	request: "依頼文",
	steps: ids.map((id, i) => ({
		id,
		bundle: "compute.python",
		task: `手順${i}`,
		from: i === 0 ? ["request"] : [ids[i - 1] as string],
		result: `結果${i}`,
	})),
	output: { from: [ids[ids.length - 1] as string], deliver: "届ける" },
});

describe("normalizeStepId", () => {
	test("snake_case, case and separators collapse to the contract shape", () => {
		expect(normalizeStepId("prime_count")).toBe("prime-count");
		expect(normalizeStepId("PrimeCount")).toBe("primecount");
		expect(normalizeStepId("fetch__the  data")).toBe("fetch-the-data");
		expect(normalizeStepId("step.1")).toBe("step-1");
	});

	test("a leading non-letter and an overlong id are brought into shape", () => {
		expect(normalizeStepId("9lives")).toBe("s-9lives");
		expect(normalizeStepId("___")).toBe("step");
		const long = normalizeStepId("a".repeat(60));
		expect(long).toHaveLength(40);
		expect(/^[a-z][a-z0-9-]{0,39}$/.test(long)).toBe(true);
	});
});

describe("normalizeDefinitionIds", () => {
	test("rewrites offending ids and every reference to them; content otherwise identical", () => {
		const definition = definitionWithIds(["first_step", "second-step"]);
		const result = normalizeDefinitionIds(definition);
		expect(result?.mapping).toEqual(new Map([["first_step", "first-step"]]));
		const rewritten = result?.definition as ReturnType<
			typeof definitionWithIds
		>;
		expect(rewritten.steps.map((s) => s.id)).toEqual([
			"first-step",
			"second-step",
		]);
		expect(rewritten.steps[1]?.from).toEqual(["first-step"]);
		expect(rewritten.output.from).toEqual(["second-step"]);
		// A reference that is not a step id is left exactly as written.
		expect(rewritten.steps[0]?.from).toEqual(["request"]);
		// The original value is not mutated.
		expect(definition.steps[0]?.id).toBe("first_step");
	});

	test("already-valid ids return null (nothing to rewrite)", () => {
		expect(
			normalizeDefinitionIds(definitionWithIds(["alpha", "beta-2"])),
		).toBeNull();
	});

	test("a collision after normalization is refused", () => {
		// a_b normalizes onto the untouched a-b.
		expect(
			normalizeDefinitionIds(definitionWithIds(["a_b", "a-b"])),
		).toBeNull();
		// Two offending ids landing on the same form.
		expect(
			normalizeDefinitionIds(definitionWithIds(["a_b", "a__b"])),
		).toBeNull();
	});

	test("a rewrite landing on the reserved request reference is refused", () => {
		expect(normalizeDefinitionIds(definitionWithIds(["Request"]))).toBeNull();
	});

	test("non-definition shapes return null", () => {
		expect(normalizeDefinitionIds(null)).toBeNull();
		expect(normalizeDefinitionIds({ steps: "no" })).toBeNull();
		expect(normalizeDefinitionIds({ steps: [{ id: 1 }] })).toBeNull();
	});
});

describe("validateAuthoring with normalization", () => {
	test("an id-only failure is recovered, and the recovered definition is the normalized one", () => {
		const gate = validateAuthoring(ready(definitionWithIds(["prime_count"])), {
			normalizeIds: true,
		});
		expect(gate.normalizeAttempted).toBe(true);
		expect(gate.idsNormalized).toBe(true);
		expect(gate.issues).toEqual([]);
		expect(gate.outcome?.status).toBe("ready");
		if (gate.outcome?.status === "ready")
			expect(gate.outcome.definition.steps[0]?.id).toBe("prime-count");
	});

	test("without the flag the same failure stands (pre-normalization gate)", () => {
		const gate = validateAuthoring(ready(definitionWithIds(["prime_count"])), {
			normalizeIds: false,
		});
		expect(gate.outcome).toBeNull();
		expect(gate.normalizeAttempted).toBe(false);
		expect(gate.idsNormalized).toBe(false);
		expect(gate.issues.length).toBeGreaterThan(0);
	});

	test("a failure that is not id-only is never offered normalization", () => {
		const mixed = definitionWithIds(["prime_count"]);
		(mixed.steps[0] as { bundle: string }).bundle = "BAD BUNDLE";
		const gate = validateAuthoring(ready(mixed), { normalizeIds: true });
		expect(gate.outcome).toBeNull();
		expect(gate.normalizeAttempted).toBe(false);
	});

	test("a collision keeps the original failure and its issues", () => {
		const gate = validateAuthoring(ready(definitionWithIds(["a_b", "a-b"])), {
			normalizeIds: true,
		});
		expect(gate.outcome).toBeNull();
		expect(gate.normalizeAttempted).toBe(true);
		expect(gate.idsNormalized).toBe(false);
		expect(gate.issues.some((i) => i.includes("steps.0.id"))).toBe(true);
	});

	test("non-ready outcomes and parse failures pass through untouched", () => {
		const needsInput: ParseResult = {
			ok: true,
			outcome: { kind: "needs_input", questions: ["どこですか"] },
		};
		const gate = validateAuthoring(needsInput, { normalizeIds: true });
		expect(gate.outcome?.status).toBe("needs_input");
		expect(gate.normalizeAttempted).toBe(false);
		const failed: ParseResult = {
			ok: false,
			errors: [{ code: "x", message: "y" }],
		};
		const gate2 = validateAuthoring(failed, { normalizeIds: true });
		expect(gate2.outcome).toBeNull();
		expect(gate2.normalizeAttempted).toBe(false);
	});
});
