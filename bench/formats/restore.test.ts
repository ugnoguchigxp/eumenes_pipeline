import { describe, expect, test } from "bun:test";
import { SYNTHETIC_OUTPUTS } from "../format/synthetic.ts";
import { parseJsonFormat } from "./json.ts";
import { parseJsonWithRestore } from "./restore.ts";

/**
 * The corruption suite for the syntax-restore stage. Material: the synthetic
 * prime-count definition (a complete, valid, minified JSON document). Corruptions are
 * deterministic string surgery, split in three classes:
 * - non-destructive (a–e): restore must recover a parse whose definition is deep-equal
 *   to the original — the damage was purely syntactic;
 * - truncation (f–g): restore may recover a parse, but the content is what survived —
 *   equality is NOT claimed (the later gates judge the truncated definition);
 * - never-restorable (h): duplicate keys are ambiguity, not syntax — the strict reader
 *   must still reject them after restore, pure and mixed with other damage;
 * - (i): a valid document never triggers the stage.
 * Nothing here measures a model; it pins the stage's contract.
 */
describe("syntax restore (corruption suite)", () => {
	const base = SYNTHETIC_OUTPUTS.find(
		(s) => s.caseId === "prime-count" && s.format === "json",
	)?.output;
	if (!base) throw new Error("synthetic prime-count/json missing");
	const original = JSON.parse(base) as unknown;

	const definitionOf = (text: string) => {
		const { result, attempted, restored } = parseJsonWithRestore(text);
		return {
			result,
			attempted,
			restored,
			definition:
				result.ok && result.outcome.kind === "ready"
					? result.outcome.definition
					: undefined,
		};
	};

	test("the material itself parses strictly, untouched (i)", () => {
		const { result, attempted, restored, definition } = definitionOf(base);
		expect(result.ok).toBe(true);
		expect(attempted).toBe(false);
		expect(restored).toBe(false);
		expect(definition).toEqual(original);
	});

	const nonDestructive: [string, string][] = [
		["(a) trailing comma in an array", base.replace('"}],', '"},],')],
		["(a) trailing comma in an object", base.replace(/\}$/, ",}")],
		["(b) markdown fence (json)", `\`\`\`json\n${base}\n\`\`\``],
		["(b) markdown fence (bare)", `\`\`\`\n${base}\n\`\`\``],
		["(c) single quotes", base.replaceAll('"', "'")],
		["(d) unquoted keys", base.replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, "$1:")],
		[
			"(e) comments",
			base
				.replace("{", "{\n// 先頭のコメント\n")
				.replace('"output":', '/* 直前 */ "output":'),
		],
	];
	for (const [name, corrupted] of nonDestructive) {
		test(`${name}: recovered, definition deep-equal`, () => {
			// The corruption really breaks the strict parser (else the case proves nothing).
			expect(parseJsonFormat(corrupted).ok).toBe(false);
			const { result, attempted, restored, definition } =
				definitionOf(corrupted);
			expect(attempted).toBe(true);
			expect(restored).toBe(true);
			expect(result.ok).toBe(true);
			expect(definition).toEqual(original);
		});
	}

	test("(f) missing closing brackets: parse recovers, equality not claimed", () => {
		const corrupted = base.slice(0, -2);
		expect(parseJsonFormat(corrupted).ok).toBe(false);
		const { result, attempted, restored } = definitionOf(corrupted);
		expect(attempted).toBe(true);
		expect(restored).toBe(true);
		expect(result.ok).toBe(true);
	});

	test("(g) string truncated mid-way: parse recovers, content is the survivor", () => {
		const corrupted = base.slice(0, Math.floor(base.length * 0.55));
		expect(parseJsonFormat(corrupted).ok).toBe(false);
		const { result, attempted, restored, definition } = definitionOf(corrupted);
		expect(attempted).toBe(true);
		expect(restored).toBe(true);
		expect(result.ok).toBe(true);
		expect(definition).not.toEqual(original);
	});

	test("(h) duplicate keys: still rejected after restore", () => {
		const corrupted = base.replace(
			'"request":',
			'"request": "重複した依頼", "request":',
		);
		expect(parseJsonFormat(corrupted).ok).toBe(false);
		const { result, attempted, restored } = definitionOf(corrupted);
		expect(attempted).toBe(true);
		expect(restored).toBe(false);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.code).toBe("duplicate_key");
	});

	test("(h) duplicate keys mixed with a trailing comma: still rejected", () => {
		const corrupted = base
			.replace('"request":', '"request": "重複した依頼", "request":')
			.replace(/\}$/, ",}");
		const { result, restored } = definitionOf(corrupted);
		expect(restored).toBe(false);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.code).toBe("duplicate_key");
	});
});
