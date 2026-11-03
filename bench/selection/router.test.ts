import { describe, expect, test } from "bun:test";
import { loadBenchCatalog } from "../catalog/load.ts";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { liveConfigStatus } from "./live.ts";
import { RouterSelection } from "./router.ts";
import { StubEmbedTransport, STUB_MODEL_ID, STUB_NETWORK } from "./stub.ts";

const card = (entry: string, summary: string): ComponentCard => ({
	entry,
	bundle: null,
	title: entry,
	summary,
	useWhen: [summary],
	avoidWhen: [],
	output: { schemaRef: null, origin: "catalog" },
	effects: ["read"],
	mayAskUser: false,
});

describe("RouterSelection over the stub transport (wiring only)", () => {
	test("ranks the card whose passages share the request's words first, deterministically", async () => {
		const cards = [
			card("weather.forecast", "天気予報を調べる"),
			card("stock.quote", "株価を調べる"),
			card("timers.manage", "タイマーを設定する"),
		];
		const selection = new RouterSelection(new StubEmbedTransport());
		const a = await selection.select("明日の天気を教えて", cards);
		const b = await selection.select("明日の天気を教えて", cards);
		expect(a.candidates.map((c) => c.entry)).toEqual(
			b.candidates.map((c) => c.entry),
		);
		expect(a.candidates[0]?.entry).toBe("weather.forecast");
		expect(a.candidates.map((c) => c.rank)).toEqual([1, 2, 3]);
		expect(a.provenance.network).toBe(STUB_NETWORK);
		expect(a.provenance.modelHash).toMatch(/^[a-f0-9]{64}$/);
		expect(Number.isNaN(Date.parse(a.provenance.retrievedAt))).toBe(false);
	});

	test("covers the full offered set of the real catalog", async () => {
		const catalog = loadBenchCatalog({ policy: "ready+partial" });
		const selection = new RouterSelection(new StubEmbedTransport());
		const result = await selection.select(
			"明日の鎌倉の天気を調べてください",
			catalog.cards,
		);
		expect(result.candidates.length).toBe(catalog.cards.length);
		expect(new Set(result.candidates.map((c) => c.entry)).size).toBe(
			catalog.cards.length,
		);
		catalog.close();
	});

	test("a transport that answers the wrong shape fails loudly", async () => {
		const broken = {
			network: "broken",
			async embed(texts: readonly string[]) {
				return {
					space: {
						modelId: STUB_MODEL_ID,
						revision: "0",
						artifactDigest: "x",
						dimension: 2,
					},
					vectors: texts.map(() => [0, 0]).slice(1),
				};
			},
		};
		const selection = new RouterSelection(broken);
		await expect(
			selection.select("依頼", [card("a.b", "説明")]),
		).rejects.toThrow("vectors for");
	});
});

describe("liveConfigStatus", () => {
	test("both variables are required; absence is reported, never guessed", () => {
		expect(liveConfigStatus({})).toEqual({
			kind: "missing",
			missing: ["PIPELINE_EMBED_URL", "PIPELINE_EMBED_NETWORK"],
		});
		expect(liveConfigStatus({ PIPELINE_EMBED_URL: "https://x" })).toEqual({
			kind: "missing",
			missing: ["PIPELINE_EMBED_NETWORK"],
		});
		expect(
			liveConfigStatus({
				PIPELINE_EMBED_URL: "https://x",
				PIPELINE_EMBED_NETWORK: "net-a",
			}),
		).toEqual({
			kind: "ready",
			config: { url: "https://x", network: "net-a" },
		});
	});
});
