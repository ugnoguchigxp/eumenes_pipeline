import { describe, expect, test } from "bun:test";
import { parseJsonStrict } from "./strict-json.ts";
import { outcomeFromValue } from "./outcome.ts";

describe("parseJsonStrict", () => {
	test.each([
		'{"__proto__":{"status":"unsupported","reasons":["x"]}}',
		'{"\\u005f_proto__":{"nested":true},"constructor":{"prototype":1}}',
		'{"a":{"__proto__":null},"prototype":[1,true]}',
	])("retains own JSON properties: %s", (text) => {
		const result = parseJsonStrict(text);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.stringify(result.value)).toBe(JSON.stringify(JSON.parse(text)));
		expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
	});

	test("an inherited discriminator cannot change the authored outcome", () => {
		const value = Object.create({ status: "unsupported", reasons: ["x"] });
		const parsed = outcomeFromValue(value);
		expect(parsed).toEqual({
			ok: true,
			outcome: { kind: "ready", definition: value },
		});
		expect(
			outcomeFromValue(
				Object.assign(Object.create({ definition: {} }), { status: "ready" }),
			),
		).toMatchObject({ ok: false });
	});

	test("generated JSON data agrees with the standard parser", () => {
		for (let n = 0; n < 100; n++) {
			const value = JSON.parse(
				`{"__proto__":${n},"array":[null,true,"x\\n",${n}],"nested":{"constructor":"${n}"}}`,
			);
			const text = JSON.stringify(value);
			const parsed = parseJsonStrict(text);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(JSON.stringify(parsed.value)).toBe(text);
		}
	});
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
