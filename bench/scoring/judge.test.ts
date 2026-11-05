import { expect, test } from "bun:test";
import { buildJudgeRequest, parseJudgement } from "./judge.ts";
import { CONTRACT_VERSION } from "../../src/contracts/record.ts";
import { checkDefinition } from "../../src/check.ts";
import { createCatalogView } from "../../src/catalog.ts";
import { record } from "../../src/test-support.ts";

test("judge input has public task information but no producer, score, gold or cost fields", () => {
	const request = buildJudgeRequest({
		request: "依頼",
		providedMaterials: [],
		cards: [],
		candidate: { status: "needs_input", questions: ["対象は何ですか"] },
	});
	const body = JSON.parse(request.prompt);
	expect(Object.keys(body).sort()).toEqual([
		"authoringContract",
		"candidate",
		"cards",
		"mode",
		"providedMaterials",
		"request",
	]);
	expect(request.purpose).toBe("judge");
	expect(body.mode).toBe("plan");
	expect(request.outputSchema).toBeObject();
	expect(body.authoringContract.version).toBe(CONTRACT_VERSION);
	expect(() =>
		buildJudgeRequest({
			request: "x",
			providedMaterials: [],
			cards: [],
			candidate: {},
			mode: "execution",
		}),
	).toThrow("actual observed");
});

test("judge receives the checker's resolved public entry even when its bundle name differs", () => {
	const component = record("entry.name", { bundle: "different-bundle" });
	const view = createCatalogView([component], {
		version: "fixture",
		offer: () => true,
	});
	const definition = {
		request: "r",
		steps: [
			{
				id: "s",
				bundle: "entry.name",
				task: "t",
				from: ["request"],
				result: "x",
			},
		],
		output: { from: ["s"], deliver: "d" },
	};
	const check = checkDefinition(definition, view, { sourceRequest: "r" });
	expect(check.ok).toBe(true);
	const built = buildJudgeRequest({
		request: "r",
		providedMaterials: [],
		cards: [component.card],
		candidate: { kind: "ready", definition },
		structuralCheck: check,
	});
	expect(JSON.parse(built.prompt).structuralCheck).toMatchObject({
		ok: true,
		resolvedSteps: [{ id: "s", entry: "entry.name", from: ["request"] }],
	});
});

test("unparseable, inconsistent and uncertain verdicts never become a successful judgement", () => {
	const criteria = {
		coverage: "pass",
		selection: "pass",
		dependencies: "pass",
		delivery: "pass",
		unnecessaryActions: "pass",
	};
	expect(
		parseJudgement(
			JSON.stringify({ verdict: "appropriate", criteria, rationale: "根拠" }),
		).verdict,
	).toBe("appropriate");
	expect(() =>
		parseJudgement(
			JSON.stringify({
				verdict: "appropriate",
				criteria: { ...criteria, delivery: "fail" },
				rationale: "欠落",
			}),
		),
	).toThrow("conflicts");
	expect(
		parseJudgement(
			JSON.stringify({
				verdict: "unknown",
				criteria: { ...criteria, delivery: "unknown" },
				rationale: "観測なし",
			}),
		).verdict,
	).toBe("unknown");
	expect(() =>
		parseJudgement('{"verdict":"unknown","verdict":"appropriate"}'),
	).toThrow("strict JSON");
});
