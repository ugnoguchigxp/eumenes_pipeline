import { describe, expect, test } from "bun:test";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import { renderCardsTextCompact } from "../formats/cards.ts";
import { FORMAT_IDS } from "../formats/index.ts";
import { WORKED_EXAMPLES } from "./conditions.ts";
import { buildFormatPrompt, MINIFIED_JSON_INSTRUCTION } from "./prompt.ts";

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

	test("compact style renders the compact cards and drops the full lists", () => {
		const baseline = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
		});
		const compact = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
			cardStyle: "compact",
		});
		expect(compact.prompt).toContain(renderCardsTextCompact(catalog.cards));
		expect(compact.prompt).not.toContain("使う場面");
		expect(compact.prompt).not.toBe(baseline.prompt);
		// The condition changes the prompt only: system and request stay put.
		expect(compact.system).toBe(baseline.system);
		expect(compact.prompt).toContain(prime.request);
		// Explicit full style is the baseline, byte for byte.
		expect(
			buildFormatPrompt({
				evalCase: prime,
				format: "json",
				cards: catalog.cards,
				cardStyle: "full",
			}),
		).toEqual(baseline);
	});

	test("oneshot appends the format's worked example to the prompt, not the system", () => {
		for (const format of FORMAT_IDS) {
			const baseline = buildFormatPrompt({
				evalCase: prime,
				format,
				cards: catalog.cards,
			});
			const oneshot = buildFormatPrompt({
				evalCase: prime,
				format,
				cards: catalog.cards,
				workedExample: WORKED_EXAMPLES[format],
			});
			expect(oneshot.system).toBe(baseline.system);
			expect(oneshot.prompt.startsWith(baseline.prompt)).toBe(true);
			expect(oneshot.prompt).toContain("## 作業例");
			expect(oneshot.prompt).toContain(WORKED_EXAMPLES[format]);
		}
		// The examples differ per format, so under oneshot the prompts differ too.
		const prompts = FORMAT_IDS.map(
			(format) =>
				buildFormatPrompt({
					evalCase: prime,
					format,
					cards: catalog.cards,
					workedExample: WORKED_EXAMPLES[format],
				}).prompt,
		);
		expect(new Set(prompts).size).toBe(3);
	});

	test("minified output style appends one line to the json system and nothing else", () => {
		const baseline = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
		});
		const minified = buildFormatPrompt({
			evalCase: prime,
			format: "json",
			cards: catalog.cards,
			outputStyle: "minified",
		});
		// The prompt (cards, request, materials) is untouched; the system gains exactly
		// the minified instruction as its last line.
		expect(minified.prompt).toBe(baseline.prompt);
		expect(minified.system).toBe(
			`${baseline.system}\n${MINIFIED_JSON_INSTRUCTION}`,
		);
		// An explicit default style is the baseline, byte for byte.
		expect(
			buildFormatPrompt({
				evalCase: prime,
				format: "json",
				cards: catalog.cards,
				outputStyle: "default",
			}),
		).toEqual(baseline);
	});

	test("minified output style leaves the other formats byte-identical", () => {
		for (const format of ["md-yaml", "free-md"] as const) {
			const baseline = buildFormatPrompt({
				evalCase: prime,
				format,
				cards: catalog.cards,
			});
			expect(
				buildFormatPrompt({
					evalCase: prime,
					format,
					cards: catalog.cards,
					outputStyle: "minified",
				}),
			).toEqual(baseline);
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
