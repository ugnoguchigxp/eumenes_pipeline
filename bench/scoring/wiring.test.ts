import { describe, expect, test } from "bun:test";
import { matchesWiring, wiringAlternative } from "./wiring.ts";

describe("evaluator role graph matching", () => {
	const rule = wiringAlternative.parse({
		roles: [
			{ id: "input", entries: ["read"] },
			{ id: "result", entries: ["write", "render"] },
		],
		edges: [{ from: "input", to: "result" }],
		deliver: ["result"],
	});
	test("accepts different step names and alternate entries", () => {
		expect(
			matchesWiring(
				[
					{ id: "x", entry: "read", from: [] },
					{ id: "y", entry: "render", from: ["x"] },
				],
				["y"],
				[rule],
			),
		).toBe(true);
	});
	test("rejects missing edges and undelivered results", () => {
		const steps = [
			{ id: "x", entry: "read", from: [] },
			{ id: "y", entry: "write", from: ["x"] },
		];
		expect(matchesWiring(steps, ["x"], [rule])).toBe(false);
		expect(
			matchesWiring([steps[0]!, { ...steps[1]!, from: [] }], ["y"], [rule]),
		).toBe(false);
	});
	test("binds repeated entries to distinct matching roles", () => {
		const repeated = wiringAlternative.parse({
			roles: [
				{ id: "a", entries: ["same"] },
				{ id: "b", entries: ["same"] },
			],
			edges: [{ from: "a", to: "b" }],
			deliver: ["b"],
		});
		expect(
			matchesWiring(
				[
					{ id: "one", entry: "same", from: [] },
					{ id: "two", entry: "same", from: ["one"] },
				],
				["two"],
				[repeated],
			),
		).toBe(true);
		expect(
			matchesWiring(
				[{ id: "one", entry: "same", from: [] }],
				["one"],
				[repeated],
			),
		).toBe(false);
	});
	test("invalid role references are rejected before evaluation", () => {
		expect(
			wiringAlternative.safeParse({
				...rule,
				edges: [{ from: "missing", to: "result" }],
			}).success,
		).toBe(false);
	});
});
