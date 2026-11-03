import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

describe("countTokens", () => {
	test("maps helper counts back in order, deterministically", () => {
		const texts = ["abc", "あいう", ""];
		expect(countTokens(texts, { run: fakeRunner })).toEqual([3, 3, 0]);
		expect(countTokens(texts, { run: fakeRunner })).toEqual(
			countTokens(texts, { run: fakeRunner }),
		);
		expect(countTokens([], { run: fakeRunner })).toEqual([]);
	});

	test("a malformed helper reply counts as unavailable, never as zero", () => {
		expect(countTokens(["x"], { run: () => "not json\n" })).toEqual([null]);
		expect(countTokens(["x"], { run: () => "" })).toEqual([null]);
		expect(
			countTokens(["x"], {
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
		// The tokenizer file exists in this environment, but the guard installed by the
		// test preload allows no process: counting must degrade to null, not throw.
		expect(countTokens(["テスト"])).toEqual([null]);
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
		const provenance = tokenizerProvenance({ run: fakeRunner });
		const source = JSON.parse(
			readFileSync(join(dirname(tokenizerFilePath()), "source.json"), "utf8"),
		) as { repo: string; revision: string; sha256: string };
		expect(provenance.available).toBe(true);
		expect(provenance.repo).toBe(source.repo);
		expect(provenance.revision).toBe(source.revision);
		expect(provenance.sha256).toBe(source.sha256);
		expect(provenance.file).toBe(tokenizerFilePath());
	});
});
