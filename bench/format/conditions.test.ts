import { describe, expect, test } from "bun:test";
import { checkDefinition } from "../../src/check.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import { FORMAT_PARSERS, FORMAT_IDS } from "../formats/index.ts";
import {
	BASELINE_CONDITION,
	CONDITIONS,
	resolveCondition,
	subsetConditionId,
	summarizeCondition,
	WORKED_EXAMPLES,
	WORKED_EXAMPLE_REQUEST,
} from "./conditions.ts";

describe("condition registry", () => {
	test("pins the three fixed conditions", () => {
		expect(BASELINE_CONDITION).toEqual({
			id: "baseline",
			cardSet: "all",
			cardStyle: "full",
			shots: 0,
		});
		expect(CONDITIONS.compact).toEqual({
			id: "compact",
			cardSet: "all",
			cardStyle: "compact",
			shots: 0,
		});
		expect(CONDITIONS.oneshot).toEqual({
			id: "oneshot",
			cardSet: "all",
			cardStyle: "full",
			shots: 1,
		});
		expect(Object.keys(CONDITIONS).sort()).toEqual([
			"baseline",
			"compact",
			"oneshot",
		]);
	});

	test("resolves by id and refuses unknown ids loudly", () => {
		expect(resolveCondition("compact")).toBe(CONDITIONS.compact);
		expect(() => resolveCondition("no-such-condition")).toThrow(
			"unknown condition",
		);
	});

	test("subset condition ids carry the candidate file's digest prefix", () => {
		expect(subsetConditionId("0123456789abcdef")).toBe("subset:01234567");
		expect(
			summarizeCondition(
				{ id: "subset:01234567", cardSet: "all", cardStyle: "full", shots: 0 },
				true,
			),
		).toEqual({
			id: "subset:01234567",
			cardSet: "subset",
			cardStyle: "full",
			shots: 0,
		});
		expect(summarizeCondition(BASELINE_CONDITION, false).cardSet).toBe("all");
	});
});

describe("worked examples (oneshot)", () => {
	const catalog = loadBenchCatalog({ policy: "ready+partial" });

	test("one per format, all different, all naming the same example request", () => {
		expect(new Set(FORMAT_IDS.map((f) => WORKED_EXAMPLES[f])).size).toBe(3);
		for (const format of FORMAT_IDS)
			expect(WORKED_EXAMPLES[format]).toContain(WORKED_EXAMPLE_REQUEST);
	});

	test("the example request is identical to no case request in the whole set", () => {
		for (const evalCase of loadCases())
			expect(evalCase.request).not.toBe(WORKED_EXAMPLE_REQUEST);
	});

	test("each example parses to a ready definition that passes checkDefinition", () => {
		for (const format of FORMAT_IDS) {
			const parsed = FORMAT_PARSERS[format](WORKED_EXAMPLES[format]);
			if (!parsed.ok)
				throw new Error(
					`${format} example does not parse: ${JSON.stringify(parsed.errors)}`,
				);
			if (parsed.outcome.kind !== "ready")
				throw new Error(`${format} example is not a ready definition`);
			const check = checkDefinition(parsed.outcome.definition, catalog.view);
			if (!check.ok)
				throw new Error(
					`${format} example fails check: ${JSON.stringify(check.issues)}`,
				);
			// The single step the example teaches: weather.forecast with its arguments.
			expect(check.plan.steps).toHaveLength(1);
			expect(check.plan.steps[0]?.entry).toBe("weather.forecast");
			expect(check.plan.steps[0]?.arguments).toEqual({
				place: "福岡",
				prefecture: "福岡県",
				day: "tomorrow",
			});
		}
		catalog.close();
	});
});
