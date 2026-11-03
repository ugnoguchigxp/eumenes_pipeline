import { afterAll, describe, expect, test } from "bun:test";
import { createCatalogView } from "../../src/catalog.ts";
import type { StepExecution } from "../../src/contracts/execution.ts";
import { loadBenchCatalog, sha256 } from "../catalog/load.ts";
import { MockHost, type MockScenario } from "./host.ts";

const catalog = loadBenchCatalog({ policy: "ready+partial" });
afterAll(() => catalog.close());

const step = (
	entry: string,
	extra: Partial<StepExecution> = {},
): StepExecution => {
	const request = "テストの作業";
	return {
		runId: "run",
		stepId: "s1",
		entry,
		revisionId: catalog.view.all.get(entry)?.evidence.toolchainRevisionId ?? "",
		request,
		references: [],
		source: { request, digest: sha256(request) },
		deadline: Date.now() + 60_000,
		...extra,
	};
};
const host = (
	scenario?: (s: StepExecution) => MockScenario,
	argumentsPolicy?: "required",
) =>
	new MockHost({
		catalog: catalog.view,
		contracts: catalog.contracts,
		seed: "test",
		...(scenario ? { scenario } : {}),
		...(argumentsPolicy ? { argumentsPolicy } : {}),
	});

describe("MockHost", () => {
	test("answers with the chosen entry's own contract, valid and recorded", async () => {
		const h = host();
		const result = await h.executeStep(step("compute.python"));
		expect(result.state).toBe("completed");
		expect(
			catalog.contracts.validate("domain:compute.receipt@1", result.output).ok,
		).toBe(true);
		expect(result.references[0]).toMatchObject({
			kind: "result",
			owner: "compute",
		});
		expect(h.calls).toEqual([
			expect.objectContaining({
				entry: "compute.python",
				state: "completed",
				scenario: "complete",
			}),
		]);
	});

	test("a wrong choice gets the wrong entry's result, not the expected one", async () => {
		// The request asks for a picture; the step chose the timer entry. The mock cannot know better.
		const result = await host().executeStep(
			step("timers.manage", { request: "町並みの画像を作る" }),
		);
		expect(
			catalog.contracts.validate("domain:timers.receipt@1", result.output).ok,
		).toBe(true);
		expect(
			catalog.contracts.validate("fixture:image.create.result@1", result.output)
				.ok,
		).toBe(false);
	});

	test("fixture artifacts are also handed on as artifact references", async () => {
		const result = await host().executeStep(step("image.create"));
		expect(result.references.map((r) => r.kind)).toEqual([
			"result",
			"artifact",
		]);
	});

	test("summary-only entries return no output", async () => {
		const result = await host().executeStep(step("web.search"));
		expect(result.state).toBe("completed");
		expect(result.output).toBeUndefined();
		expect(result.references).toHaveLength(1);
	});

	test("is deterministic for the same seed, entry, step and request", async () => {
		const a = await host().executeStep(step("kanban.manage"));
		const b = await host().executeStep(step("kanban.manage"));
		expect(a).toEqual(b);
	});

	test.each([
		["unknown entry", step("image-generation"), "unknown_entry"],
		["excluded entry", step("pipeline.studio"), "entry_not_executable"],
		[
			"stale revision",
			step("compute.python", { revisionId: "toolchain:compute.python@0" }),
			"revision_mismatch",
		],
		[
			"arguments on a command entry",
			step("compute.python", { arguments: { x: 1 } }),
			"unexpected_arguments",
		],
		[
			"invalid instant arguments",
			step("weather.forecast", { arguments: { place: "" } }),
			"invalid_arguments",
		],
	])("fails on %s", async (_name, input, code) => {
		const result = await host().executeStep(input);
		expect(result).toMatchObject({ state: "failed", code });
	});

	test("instant arguments: synthesized by default, required under the strict policy", async () => {
		const loose = host();
		await loose.executeStep(step("weather.forecast"));
		expect(loose.calls[0]?.argumentsSource).toBe("synthesized");
		const strict = await host(undefined, "required").executeStep(
			step("weather.forecast"),
		);
		expect(strict).toMatchObject({
			state: "failed",
			code: "missing_arguments",
		});
	});

	test("valid instant arguments from the step are accepted", async () => {
		const h = host();
		const result = await h.executeStep(
			step("weather.forecast", {
				arguments: { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" },
			}),
		);
		expect(result.state).toBe("completed");
		expect(h.calls[0]?.argumentsSource).toBe("step");
	});

	test("expired before start and aborted before start", async () => {
		expect(
			await host().executeStep(step("compute.python", { deadline: 0 })),
		).toMatchObject({ state: "expired" });
		const controller = new AbortController();
		controller.abort();
		expect(
			await host().executeStep(step("compute.python"), controller.signal),
		).toMatchObject({
			state: "cancelled",
		});
	});

	test("host defect scenarios", async () => {
		const dropped = await host(() => ({ kind: "drop-output" })).executeStep(
			step("compute.python"),
		);
		expect(dropped.state).toBe("completed");
		expect(dropped.output).toBeUndefined();
		const wrong = await host(() => ({ kind: "wrong-type" })).executeStep(
			step("compute.python"),
		);
		expect(
			catalog.contracts.validate("domain:compute.receipt@1", wrong.output).ok,
		).toBe(false);
	});

	test("a question stops with waiting_input", async () => {
		const result = await host(() => ({
			kind: "ask",
			question: "どれ？",
		})).executeStep(step("kanban.manage"));
		expect(result).toMatchObject({
			state: "waiting_input",
			question: "どれ？",
		});
	});
});

describe("MockHost argument checks without an extracted input contract", () => {
	test("validates against the card's own schema, for step and synthesized arguments", async () => {
		const weather = catalog.view.all.get("weather.forecast");
		if (!weather) throw new Error("weather.forecast missing from the snapshot");
		const bare = {
			...weather,
			evidence: { ...weather.evidence, inputSchemaRefs: [] },
		};
		const view = createCatalogView([bare], {
			version: "test",
			offer: () => true,
		});
		const h = new MockHost({
			catalog: view,
			contracts: catalog.contracts,
			seed: "t",
		});
		const invalid = await h.executeStep(
			step("weather.forecast", { arguments: { place: "" } }),
		);
		expect(invalid).toMatchObject({
			state: "failed",
			code: "invalid_arguments",
		});
		const synthesized = await h.executeStep(step("weather.forecast"));
		expect(synthesized.state).toBe("completed");
		expect(h.calls[1]?.argumentsSource).toBe("synthesized");
	});
});
