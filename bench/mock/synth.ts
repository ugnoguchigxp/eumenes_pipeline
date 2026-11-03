/**
 * Deterministic synthetic values from a JSON Schema, for mock results that follow the entry's own
 * contract (plan §10: "型に合う合成値やダミーの成果物参照を返す").
 *
 * Minimal on purpose: required properties only, the smallest arrays allowed (at least one item), the
 * first fitting candidate for patterns. The caller validates the value against the same contract and
 * treats a mismatch as a bench defect, never as a tool result.
 */
import { createHash } from "node:crypto";

type Schema = Record<string, unknown>;

export class SynthesisError extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(`cannot synthesize ${path || "(root)"}: ${reason}`);
	}
}

/** mulberry32 seeded from the seed text's SHA-256. */
function rng(seed: string): () => number {
	let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BASE_TIME = Date.UTC(2026, 10, 3, 0, 0, 0);

export function synthesize(schema: Schema, seed: string): unknown {
	const random = rng(seed);
	const hex = (length: number) =>
		Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join(
			"",
		);
	const uuid = () =>
		`${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`;
	const pick = <T>(items: readonly T[]): T => {
		const item = items[Math.floor(random() * items.length)];
		if (item === undefined) throw new Error("pick from empty list");
		return item;
	};

	const resolveRef = (ref: string, path: string): Schema => {
		const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
		const defs = match?.[1]
			? (schema[match[1]] as Schema | undefined)
			: undefined;
		const target = match?.[2] ? defs?.[match[2]] : undefined;
		if (!target || typeof target !== "object")
			throw new SynthesisError(path, `unresolvable $ref ${ref}`);
		return target as Schema;
	};

	const string = (node: Schema, path: string): string => {
		const min = typeof node.minLength === "number" ? node.minLength : 0;
		const max = typeof node.maxLength === "number" ? node.maxLength : 64;
		const fit = (text: string) =>
			(text.length < min ? text.padEnd(min, "x") : text).slice(0, max);
		switch (node.format) {
			case "uuid":
				return uuid();
			case "date-time":
				return new Date(
					BASE_TIME + Math.floor(random() * 86_400) * 1000,
				).toISOString();
			case "date":
				return "2026-11-03";
			case "time":
				return "12:00:00";
			case "email":
				return "mock@example.invalid";
			case "uri":
			case "url":
				return `https://example.invalid/mock/${hex(8)}`;
			default:
				break;
		}
		const candidates = [
			`mock-${hex(8)}`,
			`mock${hex(6)}`,
			hex(8),
			"mock",
			"a",
			"A",
			"1",
		].map(fit);
		if (typeof node.pattern !== "string") return candidates[0] ?? "mock";
		const pattern = new RegExp(node.pattern, "u");
		const found = candidates.find((c) => pattern.test(c));
		if (found === undefined)
			throw new SynthesisError(path, `no candidate matches /${node.pattern}/`);
		return found;
	};

	const number = (node: Schema, integer: boolean): number => {
		const lo =
			typeof node.minimum === "number"
				? node.minimum
				: typeof node.exclusiveMinimum === "number"
					? node.exclusiveMinimum + 1
					: 0;
		const hi =
			typeof node.maximum === "number"
				? node.maximum
				: typeof node.exclusiveMaximum === "number"
					? node.exclusiveMaximum - 1
					: lo + 100;
		// Small values near 1 (inside the bounds) read like real counts and revisions.
		const start = Math.min(Math.max(1, lo), hi);
		const top = Math.min(hi, start + 100);
		if (integer) {
			const from = Math.ceil(start);
			return from + Math.floor(random() * (Math.floor(top) - from + 1));
		}
		return Math.round((start + random() * (top - start)) * 100) / 100;
	};

	const gen = (node: Schema, path: string, depth: number): unknown => {
		if (depth > 16) throw new SynthesisError(path, "schema nests too deep");
		if (typeof node.$ref === "string")
			return gen(resolveRef(node.$ref, path), path, depth + 1);
		if ("const" in node) return node.const;
		if (Array.isArray(node.enum)) return pick(node.enum);
		for (const key of ["anyOf", "oneOf"] as const) {
			const options = node[key];
			if (Array.isArray(options) && options.length > 0) {
				const usable = (options as Schema[]).filter((o) => o.type !== "null");
				return gen(
					pick(usable.length ? usable : (options as Schema[])),
					path,
					depth + 1,
				);
			}
		}
		if (Array.isArray(node.allOf)) {
			const parts = (node.allOf as Schema[]).map((part) =>
				gen(part, path, depth + 1),
			);
			return Object.assign(
				{},
				...parts.filter((p) => p && typeof p === "object"),
			);
		}
		let type = node.type;
		if (Array.isArray(type)) type = type.find((t) => t !== "null") ?? type[0];
		if (type === undefined && node.properties) type = "object";
		switch (type) {
			case "object": {
				const properties = (node.properties ?? {}) as Record<string, Schema>;
				const required = (node.required ?? []) as string[];
				return Object.fromEntries(
					required.map((key) => [
						key,
						properties[key]
							? gen(properties[key], path ? `${path}.${key}` : key, depth + 1)
							: "mock",
					]),
				);
			}
			case "array": {
				const prefix = (node.prefixItems ?? []) as Schema[];
				const min = Math.max(
					typeof node.minItems === "number" ? node.minItems : 0,
					prefix.length,
				);
				const max =
					typeof node.maxItems === "number" ? node.maxItems : Math.max(min, 1);
				const count = Math.min(Math.max(min, 1), max);
				const items = (node.items ?? {}) as Schema;
				return Array.from({ length: count }, (_, i) =>
					gen(prefix[i] ?? items, `${path}[${i}]`, depth + 1),
				);
			}
			case "string":
				return string(node, path);
			case "integer":
				return number(node, true);
			case "number":
				return number(node, false);
			case "boolean":
				return random() < 0.5;
			case "null":
				return null;
			case undefined:
				return "mock";
			default:
				throw new SynthesisError(path, `unsupported type ${String(type)}`);
		}
	};
	return gen(schema, "", 0);
}
