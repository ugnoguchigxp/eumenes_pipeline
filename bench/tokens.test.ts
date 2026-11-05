import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	countTokens,
	isTokenizerCommand,
	tokenizerCommand,
	tokenizerFilePath,
	tokenizerProvenance,
	type TokenCountRunner,
} from "./tokens.ts";

/**
 * A runner that speaks the helper protocol with a fixed rule (code points per text), so
 * the plumbing — ordering, batching, failure handling — is tested without a process.
 * The real helper cannot run inside the test process at all: the preload installs the
 * reach guard with no allowances, so the spawn below is blocked by design (real counts
 * are exercised by the bench:format CLI, which allows exactly this one command).
 */
const fakeRunner: TokenCountRunner = (_command, input) =>
	input
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const { text } = JSON.parse(line) as { text: string };
			return JSON.stringify({ count: [...text].length });
		})
		.join("\n") + "\n";

// The injected runner tests the protocol, not a real model tokenizer.
const fixtureDir = mkdtempSync(join(tmpdir(), "pipeline-tokenizer-test-"));
const fixture = JSON.stringify({ fixture: "protocol-only" });
const source = {
	repo: "test/protocol-fixture",
	revision: "fixture-v1",
	sha256: createHash("sha256").update(fixture).digest("hex"),
};
const env = {
	PIPELINE_TOKENIZER_FILE: join(fixtureDir, "tokenizer.json"),
	PIPELINE_TOKENIZER_PYTHON: "python3",
};
writeFileSync(env.PIPELINE_TOKENIZER_FILE, fixture);
writeFileSync(join(fixtureDir, "source.json"), JSON.stringify(source));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe("countTokens", () => {
	test("maps helper counts back in order, deterministically", () => {
		const texts = ["abc", "あいう", ""];
		expect(countTokens(texts, { env, run: fakeRunner })).toEqual([3, 3, 0]);
		expect(countTokens(texts, { env, run: fakeRunner })).toEqual(
			countTokens(texts, { env, run: fakeRunner }),
		);
		expect(countTokens([], { env, run: fakeRunner })).toEqual([]);
	});

	test("a malformed helper reply counts as unavailable, never as zero", () => {
		expect(countTokens(["x"], { env, run: () => "not json\n" })).toEqual([
			null,
		]);
		expect(countTokens(["x"], { env, run: () => "" })).toEqual([null]);
		expect(
			countTokens(["x"], {
				env,
				run: () => {
					throw new Error("boom");
				},
			}),
		).toEqual([null]);
	});

	test("a missing tokenizer file yields nulls without running anything", () => {
		const env = { PIPELINE_TOKENIZER_FILE: "/nonexistent/tokenizer.json" };
		expect(countTokens(["x"], { env })).toEqual([null]);
		expect(countTokens(["x"], { env, run: fakeRunner })).toEqual([null]);
	});

	test("the real spawn is blocked under the test guard, so counts stay null", () => {
		// The fixture exists, but the guard installed by the
		// test preload allows no process: counting must degrade to null, not throw.
		expect(countTokens(["テスト"], { env })).toEqual([null]);
	});
});

describe("tokenizer command and provenance", () => {
	test("the command is exactly [python, helper, tokenizer file]", () => {
		const command = tokenizerCommand();
		expect(command).toHaveLength(3);
		expect(command[1]).toEndWith("tokenizer_helper.py");
		expect(command[2]).toBe(tokenizerFilePath());
		expect(isTokenizerCommand(command)).toBe(true);
		expect(isTokenizerCommand(["python3", "something-else.py"])).toBe(false);
		expect(isTokenizerCommand([...command, "extra"])).toBe(false);
	});

	test("provenance is all-null when the tokenizer file is absent", () => {
		expect(
			tokenizerProvenance({
				env: { PIPELINE_TOKENIZER_FILE: "/nonexistent/tokenizer.json" },
			}),
		).toEqual({
			available: false,
			repo: null,
			revision: null,
			file: null,
			sha256: null,
		});
	});

	test("provenance reports the recorded source of the downloaded tokenizer", () => {
		const provenance = tokenizerProvenance({ env, run: fakeRunner });
		expect(provenance.available).toBe(true);
		expect(provenance.repo).toBe(source.repo);
		expect(provenance.revision).toBe(source.revision);
		expect(provenance.sha256).toBe(source.sha256);
		expect(provenance.file).toBe(tokenizerFilePath(env));
	});
});
