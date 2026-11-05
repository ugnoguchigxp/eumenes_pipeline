import { afterAll, describe, expect, test } from "bun:test";
import { loadCases } from "../cases/cases.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import { VALID } from "../fixtures/verify-definitions.ts";
import { parseJsonFormat } from "../formats/json.ts";
import { runAttempt } from "./evaluate.ts";
import { scoreCase } from "./score.ts";

const catalog = loadBenchCatalog();
afterAll(() => catalog.close());
const env = { view: catalog.view, contracts: catalog.contracts };
const cases = new Map(loadCases().map((c) => [c.id, c]));
const getCase = (id: string) => {
	const c = cases.get(id);
	if (!c) throw new Error(`no case ${id}`);
	return c;
};

let seq = 0;
const scoreText = async (caseId: string, text: string) => {
	const attempt = await runAttempt(
		parseJsonFormat(text),
		env,
		`score-test-${++seq}`,
	);
	return scoreCase(getCase(caseId), attempt, catalog.view);
};
const scoreDefinition = (caseId: string, definition: unknown) =>
	scoreText(caseId, JSON.stringify(definition));

const countStep = {
	id: "count",
	bundle: "compute.python",
	task: "1から100までの素数の個数を計算する",
	from: ["request"],
	result: "素数の個数",
};
const primeDefinition = {
	request: getCase("prime-count").request,
	steps: [countStep],
	output: { from: ["count"], deliver: "素数の個数を伝える" },
};

describe("scoreCase: passing attempts", () => {
	test("a correct ready-only pipeline passes every aspect", async () => {
		const score = await scoreDefinition("prime-count", primeDefinition);
		expect(score).toMatchObject({
			parseOk: true,
			checkOk: true,
			stateMatch: true,
			requiredHits: ["compute.python"],
			requiredMisses: [],
			acceptableExtra: [],
			materialsWired: null,
			mockCompleted: true,
			finalArtifactMatch: null,
			fixtureDependent: false,
		});
		expect(score.score.passed).toBe(true);
	});

	test("an acceptable entry may join, but never substitutes for a required one", async () => {
		const withExtra = {
			...primeDefinition,
			steps: [
				countStep,
				{
					id: "verify",
					bundle: "cli.run",
					task: "計算結果をシェルでも検算する",
					from: ["count"],
					result: "検算結果",
				},
			],
			output: {
				from: ["count", "verify"],
				deliver: "素数の個数と検算結果を伝える",
			},
		};
		const joined = await scoreDefinition("prime-count", withExtra);
		expect(joined.acceptableExtra).toEqual([]);
		expect(joined.score.passed).toBe(true);

		const substituted = {
			...primeDefinition,
			steps: [{ ...countStep, bundle: "cli.run" }],
		};
		const replaced = await scoreDefinition("prime-count", substituted);
		expect(replaced.requiredMisses).toEqual(["compute.python"]);
		expect(replaced.acceptableExtra).toEqual([]);
		expect(replaced.score.passed).toBe(false);
	});

	test("the §3 example passes on fixture contracts, artifact included", async () => {
		const fixture = VALID.find((f) => f.id === "research-image-music");
		const score = await scoreDefinition(
			"edo-research-image-music",
			fixture?.definition,
		);
		expect(score).toMatchObject({
			stateMatch: true,
			requiredHits: ["web.search", "image.create", "music.create"],
			materialsWired: 1,
			mockCompleted: true,
			finalArtifactMatch: true,
			fixtureDependent: true,
		});
		expect(score.score.passed).toBe(true);
	});

	test("an instant step with stated arguments passes and wires its material", async () => {
		const score = await scoreDefinition("weather-timer", {
			request: getCase("weather-timer").request,
			steps: [
				{
					id: "weather",
					bundle: "weather.forecast",
					task: "明日の鎌倉の天気を調べる",
					from: ["request"],
					arguments: { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" },
					result: "明日の鎌倉の天気",
				},
				{
					id: "timer",
					bundle: "timers.manage",
					task: "雨なら出発15分前にタイマーをかける",
					from: ["request", "weather"],
					result: "開始したタイマー",
				},
			],
			output: { from: ["weather", "timer"], deliver: "天気とタイマーを伝える" },
		});
		expect(score.materialsWired).toBe(1);
		expect(score.score.passed).toBe(true);
	});

	test("a correct unsupported answer passes without any execution", async () => {
		const score = await scoreText(
			"bank-transfer",
			JSON.stringify({
				status: "unsupported",
				reasons: ["送金を行う部品がない"],
			}),
		);
		expect(score).toMatchObject({
			stateMatch: true,
			checkOk: null,
			mockCompleted: null,
		});
		expect(score.score.passed).toBe(true);
	});
});

describe("scoreCase: failing attempts are attributed to the right aspect", () => {
	test("producing artifacts before research and omitting them from delivery fails", async () => {
		const score = await scoreDefinition("edo-research-image-music", {
			request: getCase("edo-research-image-music").request,
			steps: [
				{
					id: "picture",
					bundle: "image.create",
					task: "町並みの画像を作る",
					from: ["request"],
					result: "画像",
				},
				{
					id: "music",
					bundle: "music.create",
					task: "BGMを作る",
					from: ["request"],
					result: "BGM",
				},
				{
					id: "research",
					bundle: "web.search",
					task: "町並みを調べる",
					from: ["request"],
					result: "調査結果",
				},
			],
			output: { from: ["research"], deliver: "調査だけを伝える" },
		});
		expect(score.finalArtifactMatch).toBe(true);
		expect(score.score.passed).toBe(false);
	});
	test("a wrong bundle is a bundle miss and an extra, though the mock completes", async () => {
		const wrong = {
			...primeDefinition,
			steps: [{ ...countStep, bundle: "kanban.manage" }],
		};
		const score = await scoreDefinition("prime-count", wrong);
		expect(score.requiredMisses).toEqual(["compute.python"]);
		expect(score.acceptableExtra).toEqual(["kanban.manage"]);
		expect(score.mockCompleted).toBe(true);
		expect(score.score.bundles).toBe(false);
		expect(score.score.passed).toBe(false);
	});

	test("an unwired material fails only the materials aspect", async () => {
		const score = await scoreDefinition("weather-timer", {
			request: getCase("weather-timer").request,
			steps: [
				{
					id: "weather",
					bundle: "weather.forecast",
					task: "明日の鎌倉の天気を調べる",
					from: ["request"],
					result: "明日の鎌倉の天気",
				},
				{
					id: "timer",
					bundle: "timers.manage",
					task: "15分タイマーをかける",
					from: ["request"],
					result: "開始したタイマー",
				},
			],
			output: { from: ["timer"], deliver: "タイマーを伝える" },
		});
		expect(score.materialsWired).toBe(0);
		expect(score.materialsMissing).toEqual(["weather.forecast"]);
		expect(score.mockCompleted).toBe(true);
		expect(score.score).toMatchObject({
			materials: false,
			bundles: true,
			state: true,
		});
		expect(score.score.passed).toBe(false);
	});

	test("state mismatches fail in both directions", async () => {
		const readyForVague = await scoreDefinition(
			"vague-request",
			primeDefinition,
		);
		expect(readyForVague.stateMatch).toBe(false);
		expect(readyForVague.score.execution).toBe(false);
		expect(readyForVague.score.passed).toBe(false);

		const askingForPrime = await scoreText(
			"prime-count",
			JSON.stringify({ status: "needs_input", questions: ["範囲は？"] }),
		);
		expect(askingForPrime).toMatchObject({
			stateMatch: false,
			checkOk: null,
			mockCompleted: null,
		});
		expect(askingForPrime.score.passed).toBe(false);
	});

	test("a parse failure is recorded, never scored as a state", async () => {
		const score = await scoreText("prime-count", "{broken json");
		expect(score.parseOk).toBe(false);
		expect(score.parseErrors).toContain("syntax");
		expect(score.authoredKind).toBeNull();
		expect(score.score.passed).toBe(false);
	});

	test("an unresolvable bundle fails the check and is reported unresolved", async () => {
		const score = await scoreDefinition("edo-research-image-music", {
			request: getCase("edo-research-image-music").request,
			steps: [
				{
					id: "research",
					bundle: "research",
					task: "調べる",
					from: ["request"],
					result: "調査結果",
				},
			],
			output: { from: ["research"], deliver: "伝える" },
		});
		expect(score.checkOk).toBe(false);
		expect(score.unresolvedSteps).toEqual(["research"]);
		expect(score.requiredMisses).toEqual([
			"web.search",
			"image.create",
			"music.create",
		]);
		expect(score.mockCompleted).toBeNull();
		expect(score.score.passed).toBe(false);
	});

	test("scoring is deterministic for the same attempt", async () => {
		const a = await scoreDefinition("prime-count", primeDefinition);
		const b = await scoreDefinition("prime-count", primeDefinition);
		expect(a).toEqual(b);
	});
});
