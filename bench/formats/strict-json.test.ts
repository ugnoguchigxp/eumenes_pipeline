import { describe, expect, test } from "bun:test";
import { parseJsonStrict } from "./strict-json.ts";

describe("parseJsonStrict", () => {
	test("reads the full JSON value grammar", () => {
		const text =
			'{"a":[1,-0.5e2,0,"x\\n\\u0041\\"","\\\\",true,false,null],"b":{"c":{}},"d":[]}';
		expect(parseJsonStrict(text)).toEqual({
			ok: true,
			value: {
				a: [1, -50, 0, 'x\nA"', "\\", true, false, null],
				b: { c: {} },
				d: [],
			},
		});
	});

	test("a surrogate pair written as two escapes recombines", () => {
		expect(parseJsonStrict('"\\ud83d\\ude00"')).toEqual({
			ok: true,
			value: "😀",
		});
	});

	test.each([
		['{"a":1,"a":2}', "duplicate_key"],
		['{"a":{"b":1,"b":2}}', "duplicate_key"],
		['{"a":1} {"b":2}', "trailing_content"],
		['{"a":1,}', "syntax"],
		["[1,]", "syntax"],
		['{"a":}', "syntax"],
		['"unterminated', "syntax"],
		['"bad \\x"', "syntax"],
		["01", "syntax"],
		["1.", "syntax"],
		["1e", "syntax"],
		["1e999", "syntax"],
		["nul", "syntax"],
		["", "syntax"],
	])("rejects %s", (text, code) => {
		const result = parseJsonStrict(text);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.code).toBe(code);
	});

	test("rejects a literal control character inside a string", () => {
		expect(parseJsonStrict('"a\tb"').ok).toBe(false);
	});

	test("rejects nesting beyond the fixed depth", () => {
		const deep = "[".repeat(70) + "]".repeat(70);
		const result = parseJsonStrict(deep);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.code).toBe("too_deep");
	});

	test("reports the offset just past a duplicate key", () => {
		const result = parseJsonStrict('{"a":1,"a":2}');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.position).toBe(10);
	});
});
