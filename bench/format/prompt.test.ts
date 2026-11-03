import { describe, expect, test } from "bun:test";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import { FORMAT_IDS } from "../formats/index.ts";
import { buildFormatPrompt } from "./prompt.ts";

const catalog = loadBenchCatalog({ policy: "ready+partial" });
const cases = loadCases();
const prime = cases.find((c) => c.id === "prime-count");
if (!prime) throw new Error("seed case prime-count missing");

describe("buildFormatPrompt", () => {
	test("is deterministic and carries the request, the materials and every offered card", () => {
		for (const format of FORMAT_IDS) {
			const a = buildFormatPrompt({
				evalCase: prime,
				format,
				cards: catalog.cards,
			});
			const b = buildFormatPrompt({
				evalCase: prime,
				format,
				cards: catalog.cards,
			});
			expect(a).toEqual(b);
			expect(a.prompt).toContain(prime.request);
			// The full offered set: ready + partial records (24 entries; of the 26 enabled
			// toolchains, the 2 session ones are excluded and can never be offered).
			expect(catalog.cards.length).toBe(
				catalog.records.filter((r) => r.support !== "excluded").length,
			);
			for (const card of catalog.cards) expect(a.prompt).toContain(card.entry);
		}
	});

	test("each format's instructions differ, the shared part and the prompt do not", () => {
		const built = FORMAT_IDS.map((format) =>
			buildFormatPrompt({ evalCase: prime, format, cards: catalog.cards }),
		);
		expect(new Set(built.map((b) => b.system)).size).toBe(3);
		expect(new Set(built.map((b) => b.prompt)).size).toBe(1);
	});

	test("gold never reaches the prompt: no expected bundles, notes or case flags", () => {
		for (const evalCase of cases) {
			for (const format of FORMAT_IDS) {
				const { system, prompt } = buildFormatPrompt({
					evalCase,
					format,
					cards: catalog.cards,
				});
				const text = `${system}\n${prompt}`;
				expect(text).not.toContain("requiredBundles");
				expect(text).not.toContain("acceptableBundles");
				expect(text).not.toContain("usesFixtureContracts");
				expect(text).not.toContain("expected");
				if (evalCase.notes) expect(text).not.toContain(evalCase.notes);
			}
		}
	});

	test("provided materials are listed by name and kind", () => {
		const withMaterials = cases.find((c) => c.providedMaterials.length > 0);
		if (!withMaterials) throw new Error("no case with provided materials");
		const { prompt } = buildFormatPrompt({
			evalCase: withMaterials,
			format: "json",
			cards: catalog.cards,
		});
		for (const m of withMaterials.providedMaterials) {
			expect(prompt).toContain(m.name);
			expect(prompt).toContain(m.kind);
		}
	});
});
