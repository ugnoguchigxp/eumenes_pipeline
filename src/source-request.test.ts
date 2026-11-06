import { expect, test } from "bun:test";
import { createCatalogView } from "./catalog.ts";
import { checkDefinition } from "./check.ts";
import { bindSourceRequest } from "./source-request.ts";
import { record } from "./test-support.ts";

const catalog = createCatalogView([record("solo")], {
	version: "v",
	offer: () => true,
});
const original = "電池とスイッチの回路図を作って、画像も保存してください。";
const paraphrased = {
	request: "回路図を作って画像も保存して",
	steps: [
		{ id: "a", bundle: "solo", task: "t", from: ["request"], result: "r" },
	],
	output: { from: ["a"], deliver: "提示する" },
};

test("binding replaces a paraphrased request and keeps what the model wrote", () => {
	expect(
		checkDefinition(paraphrased, catalog, { sourceRequest: original }).ok,
	).toBe(false);
	const bound = bindSourceRequest(paraphrased, original);
	expect(bound).toEqual({
		definition: { ...paraphrased, request: original },
		written: paraphrased.request,
		matched: false,
	});
	expect(paraphrased.request).toBe("回路図を作って画像も保存して");
	expect(
		checkDefinition(bound.definition, catalog, { sourceRequest: original }).ok,
	).toBe(true);
});

test("an exact copy is reported as matched and left unchanged", () => {
	const exact = { ...paraphrased, request: original };
	expect(bindSourceRequest(exact, original)).toEqual({
		definition: exact,
		written: original,
		matched: true,
	});
});
