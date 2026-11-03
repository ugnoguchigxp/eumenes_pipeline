/**
 * A strict JSON reader for the bench (plan §10: "JSONでも重複キーを黙って上書きしない").
 *
 * `JSON.parse` silently keeps the last of duplicate keys, so the format comparison cannot use it:
 * this reader implements the full JSON grammar (objects, arrays, strings with every escape,
 * numbers, literals) and fails on duplicate keys, trailing content, control characters in
 * strings, malformed numbers and non-finite results. It fails fast: the first problem is the
 * reported one, with its character offset.
 */
import { MAX_DEPTH, type ParseFailure } from "./outcome.ts";

export type StrictJsonResult =
	{ ok: true; value: unknown } | { ok: false; errors: ParseFailure[] };

class Reader {
	#index = 0;
	constructor(private readonly text: string) {}

	parse(): unknown {
		this.#ws();
		const value = this.#value(0);
		this.#ws();
		if (this.#index < this.text.length)
			this.#raise("trailing_content", "content after the JSON value");
		return value;
	}

	#raise(code: string, message: string): never {
		throw { code, message, position: this.#index } satisfies ParseFailure;
	}

	#ws(): void {
		while (this.#index < this.text.length) {
			const c = this.text[this.#index];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") this.#index++;
			else break;
		}
	}

	#peek(): string {
		const c = this.text[this.#index];
		if (c === undefined) this.#raise("syntax", "unexpected end of input");
		return c;
	}

	#value(depth: number): unknown {
		if (depth > MAX_DEPTH)
			this.#raise("too_deep", `nesting deeper than ${MAX_DEPTH}`);
		const c = this.#peek();
		if (c === "{") return this.#object(depth);
		if (c === "[") return this.#array(depth);
		if (c === '"') return this.#string();
		if (c === "t") return this.#literal("true", true);
		if (c === "f") return this.#literal("false", false);
		if (c === "n") return this.#literal("null", null);
		if (c === "-" || (c >= "0" && c <= "9")) return this.#number();
		return this.#raise("syntax", `unexpected character ${JSON.stringify(c)}`);
	}

	#literal(word: string, value: unknown): unknown {
		if (!this.text.startsWith(word, this.#index))
			this.#raise("syntax", `invalid literal, expected ${word}`);
		this.#index += word.length;
		return value;
	}

	#object(depth: number): Record<string, unknown> {
		this.#index++; // {
		const out: Record<string, unknown> = {};
		const keys = new Set<string>();
		this.#ws();
		if (this.#peek() === "}") {
			this.#index++;
			return out;
		}
		for (;;) {
			this.#ws();
			if (this.#peek() !== '"')
				this.#raise("syntax", "object key is not a string");
			const key = this.#string();
			if (keys.has(key))
				this.#raise("duplicate_key", `duplicate key ${JSON.stringify(key)}`);
			keys.add(key);
			this.#ws();
			if (this.#peek() !== ":")
				this.#raise("syntax", "expected ':' after object key");
			this.#index++;
			this.#ws();
			out[key] = this.#value(depth + 1);
			this.#ws();
			const next = this.#peek();
			if (next === ",") {
				this.#index++;
				continue;
			}
			if (next === "}") {
				this.#index++;
				return out;
			}
			this.#raise("syntax", "expected ',' or '}' in object");
		}
	}

	#array(depth: number): unknown[] {
		this.#index++; // [
		const out: unknown[] = [];
		this.#ws();
		if (this.#peek() === "]") {
			this.#index++;
			return out;
		}
		for (;;) {
			this.#ws();
			out.push(this.#value(depth + 1));
			this.#ws();
			const next = this.#peek();
			if (next === ",") {
				this.#index++;
				continue;
			}
			if (next === "]") {
				this.#index++;
				return out;
			}
			this.#raise("syntax", "expected ',' or ']' in array");
		}
	}

	#string(): string {
		this.#index++; // opening quote
		let out = "";
		for (;;) {
			const c = this.text[this.#index];
			if (c === undefined) this.#raise("syntax", "unterminated string");
			if (c === '"') {
				this.#index++;
				return out;
			}
			if (c === "\\") {
				const esc = this.text[this.#index + 1];
				switch (esc) {
					case '"':
						out += '"';
						break;
					case "\\":
						out += "\\";
						break;
					case "/":
						out += "/";
						break;
					case "b":
						out += "\b";
						break;
					case "f":
						out += "\f";
						break;
					case "n":
						out += "\n";
						break;
					case "r":
						out += "\r";
						break;
					case "t":
						out += "\t";
						break;
					case "u": {
						const hex = this.text.slice(this.#index + 2, this.#index + 6);
						if (!/^[0-9a-fA-F]{4}$/.test(hex))
							this.#raise("syntax", "invalid \\u escape");
						// Code units are appended as-is; a well-formed surrogate pair in the
						// source recombines in the resulting JS string, as with JSON.parse.
						out += String.fromCharCode(parseInt(hex, 16));
						this.#index += 4;
						break;
					}
					default:
						this.#raise("syntax", `invalid escape \\${esc ?? ""}`);
				}
				this.#index += 2;
				continue;
			}
			if (c < " ") this.#raise("syntax", "control character in string");
			out += c;
			this.#index++;
		}
	}

	#number(): number {
		const start = this.#index;
		if (this.text[this.#index] === "-") this.#index++;
		const first = this.text[this.#index];
		if (first === "0") {
			this.#index++;
			if (this.#digit(this.text[this.#index]))
				this.#raise("syntax", "invalid number: leading zero");
		} else if (first !== undefined && first >= "1" && first <= "9")
			while (this.#digit(this.text[this.#index])) this.#index++;
		else this.#raise("syntax", "invalid number");
		if (this.text[this.#index] === ".") {
			this.#index++;
			if (!this.#digit(this.text[this.#index]))
				this.#raise("syntax", "invalid number: no digit after '.'");
			while (this.#digit(this.text[this.#index])) this.#index++;
		}
		const e = this.text[this.#index];
		if (e === "e" || e === "E") {
			this.#index++;
			const sign = this.text[this.#index];
			if (sign === "+" || sign === "-") this.#index++;
			if (!this.#digit(this.text[this.#index]))
				this.#raise("syntax", "invalid number: no digit in exponent");
			while (this.#digit(this.text[this.#index])) this.#index++;
		}
		const value = Number(this.text.slice(start, this.#index));
		if (!Number.isFinite(value)) this.#raise("syntax", "number out of range");
		return value;
	}

	#digit(c: string | undefined): boolean {
		return c !== undefined && c >= "0" && c <= "9";
	}
}

/** Parse `text` as exactly one JSON value, strictly. Never throws. */
export function parseJsonStrict(text: string): StrictJsonResult {
	try {
		return { ok: true, value: new Reader(text).parse() };
	} catch (error) {
		const failure = error as ParseFailure;
		if (failure && typeof failure.code === "string")
			return { ok: false, errors: [failure] };
		throw error;
	}
}
