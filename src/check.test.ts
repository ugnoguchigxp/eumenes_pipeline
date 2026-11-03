import { describe, expect, test } from "bun:test";
import { createCatalogView } from "./catalog.ts";
import { checkDefinition, type IssueCode } from "./check.ts";
import { record } from "./test-support.ts";

const catalog = createCatalogView(
	[
		record("research", { bundle: "research-kit", output: null }),
		record("draw", { bundle: "media", output: "domain:draw@1" }),
		record("sing", { bundle: "media", output: "domain:sing@1" }),
		record("solo", { bundle: "solo-kit" }),
		record("talk", {
			bundle: "talk-kit",
			execution: "session",
			support: "excluded",
		}),
		record("legacy", {
			bundle: null,
			execution: "unbound",
			support: "partial",
		}),
	],
	{ version: "v-test", offer: (r) => r.support !== "excluded" },
);

const step = (id: string, bundle: string, from: string[], extra = {}) => ({
	id,
	bundle,
	task: `${id} task`,
	from,
	result: `${id} result`,
	...extra,
});
const definition = (steps: unknown[], outputFrom: string[]) => ({
	request: "  元の依頼  ",
	steps,
	output: { from: outputFrom, deliver: "提示する" },
});
const errorCodes = (input: unknown): IssueCode[] => {
	const result = checkDefinition(input, catalog);
	return result.issues.filter((i) => i.severity === "error").map((i) => i.code);
};

describe("checkDefinition", () => {
	test("accepts a serial plan and resolves entries, revisions and output contracts", () => {
		const result = checkDefinition(
			definition(
				[
					step("look", "research", ["request"]),
					step("picture", "media", ["request", "look"], { entry: "draw" }),
				],
				["look", "picture"],
			),
			catalog,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.request).toBe("  元の依頼  ");
		expect(result.plan.catalogVersion).toBe("v-test");
		expect(
			result.plan.steps.map((s) => [s.stepId, s.entry, s.revisionId]),
		).toEqual([
			["look", "research", "toolchain:research@1"],
			["picture", "draw", "toolchain:draw@1"],
		]);
		expect(result.plan.steps[1]?.output).toEqual({
			schemaRef: "domain:draw@1",
			origin: "eumenes-code",
		});
		expect(result.issues).toEqual([]);
	});

	test.each([
		[
			"reserved id",
			definition([step("request", "solo", [])], ["request"]),
			"reserved_id",
		],
		[
			"duplicate id",
			definition([step("a", "solo", []), step("a", "solo", [])], ["a"]),
			"duplicate_id",
		],
		[
			"forward reference",
			definition([step("a", "solo", ["b"]), step("b", "solo", [])], ["b"]),
			"forward_reference",
		],
		[
			"self reference",
			definition([step("a", "solo", ["a"])], ["a"]),
			"self_reference",
		],
		[
			"unknown reference",
			definition([step("a", "solo", ["zzz"])], ["a"]),
			"unknown_reference",
		],
		[
			"duplicate reference",
			definition([step("a", "solo", ["request", "request"])], ["a"]),
			"duplicate_reference",
		],
		[
			"unknown output reference",
			definition([step("a", "solo", [])], ["zzz"]),
			"unknown_reference",
		],
		[
			"unknown component",
			definition([step("a", "image-generation", [])], ["a"]),
			"unknown_component",
		],
		[
			"ambiguous bundle",
			definition([step("a", "media", [])], ["a"]),
			"ambiguous_entry",
		],
		[
			"entry from another bundle",
			definition([step("a", "solo-kit", [], { entry: "draw" })], ["a"]),
			"entry_not_in_bundle",
		],
		[
			"excluded entry",
			definition([step("a", "talk", [])], ["a"]),
			"component_not_offered",
		],
		[
			"excluded bundle",
			definition([step("a", "talk-kit", [])], ["a"]),
			"component_not_offered",
		],
		[
			"expression field",
			definition([step("a", "solo", [], { code: "x => x" })], ["a"]),
			"schema",
		],
		["no steps", definition([], ["request"]), "schema"],
		[
			"blank task",
			definition([step("a", "solo", [], { task: "   " })], ["a"]),
			"schema",
		],
	] as const)("rejects %s", (_name, input, code) => {
		expect(errorCodes(input)).toContain(code);
	});

	test("a single-entry bundle and an entry id both resolve without `entry`", () => {
		const result = checkDefinition(
			definition(
				[step("a", "solo-kit", ["request"]), step("b", "legacy", ["a"])],
				["b"],
			),
			catalog,
		);
		expect(result.ok && result.plan.steps.map((s) => s.entry)).toEqual([
			"solo",
			"legacy",
		]);
	});

	test("an unused result is a warning, not a rejection", () => {
		const result = checkDefinition(
			definition(
				[step("a", "solo", ["request"]), step("b", "solo", ["request"])],
				["b"],
			),
			catalog,
		);
		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([
			expect.objectContaining({
				code: "unused_result",
				path: "steps.0",
				severity: "warning",
			}),
		]);
	});

	test("ambiguity reports the candidate entries", () => {
		const result = checkDefinition(
			definition([step("a", "media", [])], ["a"]),
			catalog,
		);
		expect(result.issues[0]?.candidates).toEqual(["draw", "sing"]);
	});
});

describe("createCatalogView", () => {
	test("refuses duplicate entries", () => {
		expect(() =>
			createCatalogView([record("x"), record("x")], {
				version: "v",
				offer: () => true,
			}),
		).toThrow("duplicate entry");
	});

	test("a name that is both an entry and a multi-entry bundle is ambiguous", () => {
		const view = createCatalogView(
			[
				record("kit", { bundle: "kit" }),
				record("kit.extra", { bundle: "kit" }),
			],
			{ version: "v", offer: () => true },
		);
		expect(view.resolve("kit")).toEqual({
			ok: false,
			code: "ambiguous_entry",
			candidates: ["kit", "kit.extra"],
		});
		expect(view.resolve("kit", "kit")).toMatchObject({ ok: true });
	});
});
