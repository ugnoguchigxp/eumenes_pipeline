import { expect, test } from "bun:test";
import { MAX_JSON_DEPTH, parseJsonStrict } from "../index.ts";

test("the public strict reader refuses what JSON.parse would silently accept", () => {
	const duplicated = '{"status":"ready","status":"unsupported"}';
	expect(JSON.parse(duplicated)).toEqual({ status: "unsupported" });
	expect(parseJsonStrict(duplicated)).toMatchObject({
		ok: false,
		errors: [{ code: "duplicate_key" }],
	});
	const deep = `${"[".repeat(MAX_JSON_DEPTH + 2)}${"]".repeat(MAX_JSON_DEPTH + 2)}`;
	expect(parseJsonStrict(deep)).toMatchObject({
		ok: false,
		errors: [{ code: "too_deep" }],
	});
	expect(parseJsonStrict('{"a":[1,"x",null]}')).toEqual({
		ok: true,
		value: { a: [1, "x", null] },
	});
});
