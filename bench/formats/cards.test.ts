import { afterAll, describe, expect, test } from "bun:test";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import {
	renderCardsJson,
	renderCardsText,
	summarizeArguments,
} from "./cards.ts";

const CARDS: ComponentCard[] = [
	{
		entry: "compute.python",
		bundle: "compute",
		title: "計算",
		summary: "Pythonで計算する",
		useWhen: ["数値計算が必要"],
		avoidWhen: [],
		output: { schemaRef: "domain:compute.receipt@1", origin: "eumenes-code" },
		effects: ["read", "write"],
		mayAskUser: false,
	},
	{
		entry: "weather.forecast",
		bundle: "weather-forecast",
		title: "天気予報",
		summary: "天気を即答する",
		useWhen: ["今日の天気を聞かれた"],
		avoidWhen: ["週間予報を聞かれた"],
		arguments: {
			type: "object",
			properties: {
				place: { type: "string", description: "場所" },
				day: { type: "string", enum: ["today", "tomorrow"] },
			},
			required: ["place", "day"],
		},
		output: { schemaRef: null, origin: "missing" },
		effects: ["read"],
		mayAskUser: true,
	},
];

describe("renderCardsText", () => {
	test("pins the concise text form", () => {
		expect(renderCardsText(CARDS)).toBe(
			[
				"- `compute.python` 計算（bundle: compute）",
				"  目的: Pythonで計算する",
				"  使う場面: 数値計算が必要",
				"  使わない場面: なし",
				"  引数: なし",
				"  出力: domain:compute.receipt@1",
				"  副作用: 読み取りと書き込み",
				"  利用者への確認: しない",
				"",
				"- `weather.forecast` 天気予報（bundle: weather-forecast）",
				"  目的: 天気を即答する",
				"  使う場面: 今日の天気を聞かれた",
				"  使わない場面: 週間予報を聞かれた",
				"  引数:",
				"    - place: string（必須） — 場所",
				"    - day: enum(today|tomorrow)（必須）",
				"  出力: 要約と参照のみ",
				"  副作用: 読み取りのみ",
				"  利用者への確認: することがある",
			].join("\n"),
		);
	});

	test("never leaks contract origins or readiness", () => {
		const text = renderCardsText(CARDS);
		for (const leaked of [
			"eumenes-code",
			"origin",
			"ready",
			"partial",
			"excluded",
		])
			expect(text).not.toContain(leaked);
	});
});

describe("renderCardsJson", () => {
	test("carries the card facts and nothing else", () => {
		const parsed = JSON.parse(renderCardsJson(CARDS)) as unknown;
		expect(parsed).toEqual([
			{
				entry: "compute.python",
				bundle: "compute",
				title: "計算",
				summary: "Pythonで計算する",
				useWhen: ["数値計算が必要"],
				avoidWhen: [],
				output: "domain:compute.receipt@1",
				effects: ["read", "write"],
				mayAskUser: false,
			},
			{
				entry: "weather.forecast",
				bundle: "weather-forecast",
				title: "天気予報",
				summary: "天気を即答する",
				useWhen: ["今日の天気を聞かれた"],
				avoidWhen: ["週間予報を聞かれた"],
				arguments: CARDS[1]?.arguments,
				output: null,
				effects: ["read"],
				mayAskUser: true,
			},
		]);
		const raw = renderCardsJson(CARDS);
		for (const leaked of ["eumenes-code", "fixture", "support", "readiness"])
			expect(raw).not.toContain(leaked);
	});
});

describe("summarizeArguments", () => {
	test("keeps property order, types, required flags and descriptions", () => {
		expect(summarizeArguments(CARDS[1]?.arguments ?? {})).toEqual([
			{ name: "place", type: "string", required: true, description: "場所" },
			{ name: "day", type: "enum(today|tomorrow)", required: true },
		]);
		expect(summarizeArguments({})).toEqual([]);
	});
});

describe("rendering the real catalog", () => {
	const catalog = loadBenchCatalog();
	afterAll(() => catalog.close());

	test("is deterministic and covers every offered entry in catalog order", () => {
		const text = renderCardsText(catalog.cards);
		expect(renderCardsText(catalog.cards)).toBe(text);
		const json = renderCardsJson(catalog.cards);
		expect(renderCardsJson(catalog.cards)).toBe(json);
		const entries = catalog.cards.map((c) => c.entry);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(text).toContain(`\`${entry}\``);
			expect(json).toContain(`"entry":"${entry}"`);
		}
		const positions = entries.map((e) => text.indexOf(`\`${e}\``));
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});
});
