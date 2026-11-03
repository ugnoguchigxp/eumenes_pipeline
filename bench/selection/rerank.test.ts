import { describe, expect, test } from "bun:test";
import {
	isRerankCommand,
	RERANK_HELPER,
	rerankCommand,
	scoreRerankPairs,
} from "./rerank.ts";

const env = {
	PIPELINE_RERANK_PYTHON: "/x/python",
	// An existing directory: scoreRerankPairs refuses a missing model dir.
	PIPELINE_RERANK_MODEL: import.meta.dir,
};

describe("rerankCommand / isRerankCommand", () => {
	test("the command is exactly [python, helper, modelDir]", () => {
		expect(rerankCommand(env)).toEqual([
			"/x/python",
			RERANK_HELPER,
			import.meta.dir,
		]);
		expect(
			isRerankCommand(["/x/python", RERANK_HELPER, import.meta.dir], env),
		).toBe(true);
	});
	test("anything else is not the rerank command", () => {
		expect(isRerankCommand(["/x/python", RERANK_HELPER], env)).toBe(false);
		expect(
			isRerankCommand(["/other/python", RERANK_HELPER, import.meta.dir], env),
		).toBe(false);
		expect(
			isRerankCommand(["/x/python", "evil.py", import.meta.dir], env),
		).toBe(false);
	});
});

describe("scoreRerankPairs", () => {
	const pairs = [
		{ query: "q1", passage: "p1" },
		{ query: "q2", passage: "p2" },
	];
	test("parses one score per pair, in order", () => {
		const scores = scoreRerankPairs(pairs, {
			env,
			run: (_command, input) => {
				const lines = input.trim().split("\n");
				expect(lines).toHaveLength(2);
				return '{"score": 1.5}\n{"score": -2.25}\n';
			},
		});
		expect(scores).toEqual([1.5, -2.25]);
	});
	test("any failure yields null for the whole batch", () => {
		expect(
			scoreRerankPairs(pairs, { env, run: () => '{"score": 1}\n' }),
		).toBeNull();
		expect(
			scoreRerankPairs(pairs, {
				env,
				run: () => '{"score": "high"}\n{"score": 0}\n',
			}),
		).toBeNull();
		expect(
			scoreRerankPairs(pairs, {
				env,
				run: () => {
					throw new Error("boom");
				},
			}),
		).toBeNull();
	});
	test("a missing model directory yields null without running the helper", () => {
		let ran = false;
		const scores = scoreRerankPairs(pairs, {
			env: { PIPELINE_RERANK_MODEL: "/nonexistent-rerank-model" },
			run: () => {
				ran = true;
				return "";
			},
		});
		expect(scores).toBeNull();
		expect(ran).toBe(false);
	});
});
