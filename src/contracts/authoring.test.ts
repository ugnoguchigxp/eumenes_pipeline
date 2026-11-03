import { describe, expect, test } from "bun:test";
import { authoringOutcome } from "./authoring.ts";

const definition = {
	request: "明日の鎌倉の天気を教えて",
	steps: [
		{
			id: "w",
			bundle: "weather",
			task: "明日の天気を調べる",
			from: ["request"],
			result: "明日の天気予報",
		},
	],
	output: { from: ["w"], deliver: "天気を提示する" },
};

describe("authoringOutcome", () => {
	test("accepts a ready outcome", () => {
		expect(
			authoringOutcome.safeParse({ status: "ready", definition }).success,
		).toBe(true);
	});

	test("accepts needs_input, with and without a note", () => {
		expect(
			authoringOutcome.safeParse({
				status: "needs_input",
				questions: ["いつの天気ですか"],
			}).success,
		).toBe(true);
		expect(
			authoringOutcome.safeParse({
				status: "needs_input",
				questions: ["いつの天気ですか"],
				note: "場所は依頼文から確定できる",
			}).success,
		).toBe(true);
	});

	test("accepts unsupported with reasons", () => {
		expect(
			authoringOutcome.safeParse({
				status: "unsupported",
				reasons: ["対応する部品がない"],
			}).success,
		).toBe(true);
	});

	test("rejects a ready outcome whose definition is invalid", () => {
		expect(
			authoringOutcome.safeParse({
				status: "ready",
				definition: { ...definition, steps: [] },
			}).success,
		).toBe(false);
	});

	test("rejects extra fields (strict objects)", () => {
		expect(
			authoringOutcome.safeParse({
				status: "ready",
				definition,
				note: "ついでに",
			}).success,
		).toBe(false);
		expect(
			authoringOutcome.safeParse({
				status: "needs_input",
				questions: ["いつの天気ですか"],
				definition,
			}).success,
		).toBe(false);
	});

	test("rejects an empty questions array", () => {
		expect(
			authoringOutcome.safeParse({
				status: "needs_input",
				questions: [],
			}).success,
		).toBe(false);
	});
});
