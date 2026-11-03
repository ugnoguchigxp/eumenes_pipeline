import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SynthesisError, synthesize } from "./synth.ts";

const valid = (schema: Record<string, unknown>, seed = "s") => {
	const value = synthesize(schema, seed);
	const result = z
		.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
		.safeParse(value);
	return { value, ok: result.success };
};

describe("synthesize", () => {
	test("is deterministic per seed", () => {
		const schema = {
			type: "object",
			properties: {
				id: { type: "string", format: "uuid" },
				n: { type: "integer" },
			},
			required: ["id", "n"],
		};
		expect(synthesize(schema, "a")).toEqual(synthesize(schema, "a"));
		expect(synthesize(schema, "a")).not.toEqual(synthesize(schema, "b"));
	});

	test.each([
		["uuid", { type: "string", format: "uuid" }],
		["date-time", { type: "string", format: "date-time" }],
		["const", { type: "string", const: "open" }],
		["enum", { type: "string", enum: ["a", "b"] }],
		["bounded integer", { type: "integer", minimum: 1, maximum: 3 }],
		[
			"exclusive minimum",
			{ type: "integer", exclusiveMinimum: 0, maximum: 10 },
		],
		[
			"safe-integer range",
			{
				type: "integer",
				minimum: -9007199254740991,
				maximum: 9007199254740991,
			},
		],
		[
			"pattern",
			{ type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" },
		],
		["length", { type: "string", minLength: 12, maxLength: 12 }],
		[
			"tuple",
			{ type: "array", prefixItems: [{ type: "number" }, { type: "number" }] },
		],
		[
			"min items",
			{ type: "array", minItems: 4, maxItems: 4, items: { type: "boolean" } },
		],
		["nullable union", { anyOf: [{ type: "string" }, { type: "null" }] }],
		[
			"discriminated oneOf",
			{
				oneOf: [
					{
						type: "object",
						properties: { kind: { const: "a" } },
						required: ["kind"],
					},
					{
						type: "object",
						properties: { kind: { const: "b" } },
						required: ["kind"],
					},
				],
			},
		],
		[
			"$ref",
			{
				$defs: {
					item: {
						type: "object",
						properties: { x: { type: "integer" } },
						required: ["x"],
					},
				},
				type: "array",
				items: { $ref: "#/$defs/item" },
			},
		],
	])("%s validates against its own schema", (_name, schema) => {
		for (const seed of ["1", "2", "3", "4", "5"])
			expect(valid(schema as Record<string, unknown>, seed).ok).toBe(true);
	});

	test("only required properties are produced", () => {
		expect(
			synthesize(
				{
					type: "object",
					properties: { a: { type: "string" }, b: { type: "string" } },
					required: ["a"],
					additionalProperties: false,
				},
				"s",
			),
		).toEqual({ a: expect.any(String) });
	});

	test("an unsatisfiable pattern is a synthesis error, not a value", () => {
		expect(() =>
			synthesize({ type: "string", pattern: "^Z{3}$" }, "s"),
		).toThrow(SynthesisError);
	});
});
