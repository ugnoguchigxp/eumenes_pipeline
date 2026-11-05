import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest } from "../../src/ports.ts";
import { inferenceDigest, RecordedInference } from "./recorded.ts";
import type { ApiRecordingSource } from "./recorded.ts";

const request = (prompt: string): InferenceRequest => ({
	purpose: "compose",
	system: "指示",
	prompt,
});

describe("RecordedInference", () => {
	test("legacy API records with unknown schema identity cannot silently qualify as current input", async () => {
		const req = request("legacy-api");
		const digest = inferenceDigest(req);
		const source: ApiRecordingSource = {
			version: 1,
			evidence: "api",
			runId: "run",
			trialId: "trial",
			provider: "openai",
			model: "fixture",
			usage: {
				inputTokens: null,
				outputTokens: null,
				cachedTokens: null,
				reasoningTokens: null,
				calls: null,
			},
			durationMs: 1,
			promptDigest: digest,
			outputDigest: "a".repeat(64),
			requestId: null,
		};
		const legacy = new RecordedInference(
			[{ promptDigest: digest, output: "x", evidence: "api" }],
			new Map([[digest, source]]),
		);
		const failed = await legacy.complete(req);
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error).toContain("schema identity");
		const verified = new RecordedInference(
			[{ promptDigest: digest, output: "x", evidence: "api" }],
			new Map([[digest, { ...source, outputSchemaDigest: null }]]),
		);
		expect((await verified.complete(req)).ok).toBe(true);
	});
	test("request identity includes the forced output schema", async () => {
		const req = request("same prompt");
		const one = { ...req, outputSchema: { type: "string" } };
		const two = { ...req, outputSchema: { type: "number" } };
		expect(inferenceDigest(one)).not.toBe(inferenceDigest(req));
		expect(inferenceDigest(two)).not.toBe(inferenceDigest(one));
		const recorded = new RecordedInference([
			{ promptDigest: inferenceDigest(one), output: '"a"' },
		]);
		expect((await recorded.complete(one)).ok).toBe(true);
		expect((await recorded.complete(two)).ok).toBe(false);
		expect((await recorded.complete(req)).ok).toBe(false);
	});
	test("an API marker without provenance cannot become an agent-model record", () => {
		expect(
			() =>
				new RecordedInference([
					{
						promptDigest: inferenceDigest(request("r")),
						output: "x",
						evidence: "api",
					},
				]),
		).toThrow("provenance missing");
	});
	test("replays the recording whose digest matches the request; usage stays null", async () => {
		const req = request("依頼A");
		const inference = new RecordedInference([
			{ promptDigest: inferenceDigest(req), output: "出力A" },
		]);
		const result = await inference.complete(req);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toBe("出力A");
		expect(result.model).toBe("agent-model");
		expect(result.usage).toEqual({
			inputTokens: null,
			cachedTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			calls: null,
		});
	});

	test("a recording made for a different prompt is a digest mismatch, never replayed", async () => {
		const inference = new RecordedInference([
			{
				promptDigest: inferenceDigest(request("依頼B")),
				output: "出力B",
			},
		]);
		const result = await inference.complete(request("依頼A"));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toContain(inferenceDigest(request("依頼A")));
	});

	test("no recording at all is an explicit error, not a guess", async () => {
		const inference = new RecordedInference([]);
		const result = await inference.complete(request("依頼A"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no recording");
	});

	test("fromDirectory loads recordings and rejects malformed or duplicate files", () => {
		const dir = mkdtempSync(join(tmpdir(), "recorded-test-"));
		const req = request("依頼A");
		writeFileSync(
			join(dir, "a--json.json"),
			JSON.stringify({
				promptDigest: inferenceDigest(req),
				output: "出力A",
			}),
		);
		const { inference, files } = RecordedInference.fromDirectory(dir);
		expect([...files.keys()]).toEqual(["a--json.json"]);
		return inference.complete(req).then((result) => {
			expect(result.ok).toBe(true);
		});
	});

	test("duplicate digests across files fail loudly", () => {
		const dir = mkdtempSync(join(tmpdir(), "recorded-test-"));
		const digest = inferenceDigest(request("依頼A"));
		for (const name of ["a.json", "b.json"])
			writeFileSync(
				join(dir, name),
				JSON.stringify({ promptDigest: digest, output: "x" }),
			);
		expect(() => RecordedInference.fromDirectory(dir)).toThrow(
			"duplicate recording",
		);
	});
});
