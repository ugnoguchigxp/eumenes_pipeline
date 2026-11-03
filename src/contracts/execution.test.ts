import { describe, expect, test } from "bun:test";
import { isAdoptable, STEP_STATES, type StepResult } from "./execution.ts";

const result = (state: StepResult["state"]): StepResult => ({
	state,
	summary: "s",
	references: [],
	modelCalls: 0,
});

describe("isAdoptable", () => {
	test("only a confirmed completion may be handed to later steps", () => {
		expect(isAdoptable(result("completed"))).toBe(true);
		for (const state of STEP_STATES)
			if (state !== "completed") expect(isAdoptable(result(state))).toBe(false);
	});
});
