import { describe, expect, test } from "bun:test";
import { setContainsAll, unionPresented } from "./union.ts";

describe("unionPresented", () => {
	test("keeps the emb-prefix top-12 order, then appends unseen BM25 entries in BM25 order", () => {
		const emb = [
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
		];
		const bm25 = ["x", "b", "y", "a", "z"];
		expect(unionPresented(emb, bm25, 5)).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"x",
			"y",
			"z",
		]);
	});

	test("k=0 is exactly the emb-prefix top-12 baseline", () => {
		const emb = [
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
		];
		expect(unionPresented(emb, ["x", "y"], 0)).toEqual(emb.slice(0, 12));
	});

	test("adds nothing when the BM25 top-k is already inside the base set", () => {
		const emb = [
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
		];
		expect(unionPresented(emb, ["c", "a", "l"], 3)).toEqual(emb.slice(0, 12));
	});

	test("never duplicates an entry and never shrinks the base set", () => {
		const emb = ["a", "b", "c"];
		const bm25 = ["a", "a", "d", "d", "e"];
		const presented = unionPresented(emb, bm25, 5, 2);
		expect(presented).toEqual(["a", "b", "d", "e"]);
		expect(new Set(presented).size).toBe(presented.length);
	});
});

describe("setContainsAll", () => {
	test("requires every required entry to be presented", () => {
		expect(setContainsAll(["a", "b"], ["x", "a", "b"])).toBe(true);
		expect(setContainsAll(["a", "b"], ["a", "x"])).toBe(false);
		expect(setContainsAll([], ["a"])).toBe(true);
	});
});
