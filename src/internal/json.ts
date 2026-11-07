/** Literal JSON with bounded validation work; no application meaning is inferred here. */
import type { JsonValue } from "../contracts/definition.ts";

/** Copy validated JSON data without consulting toJSON, getters, or inherited setters. */
export function copyArguments(
	value: Record<string, JsonValue>,
): Record<string, JsonValue> {
	const copy = (input: JsonValue): JsonValue => {
		if (input === null || typeof input !== "object")
			// Keep JSON.stringify's existing normalization of negative zero.
			return typeof input === "number" && input === 0 ? 0 : input;
		const output: JsonValue[] | Record<string, JsonValue> = Array.isArray(input)
			? []
			: {};
		for (const key of Object.keys(input)) {
			const property = Object.getOwnPropertyDescriptor(input, key)!;
			Object.defineProperty(output, key, {
				value: copy(property.value),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return output;
	};
	return copy(value) as Record<string, JsonValue>;
}

export function boundedArguments(value: unknown): boolean {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length > 32
	)
		return false;
	const active = new Set<object>();
	const pending: { value: unknown; depth: number; leave?: boolean }[] = [
		{ value, depth: 0 },
	];
	let nodes = 0;
	let queuedNodes = 1;
	let textUnits = 0;
	while (pending.length) {
		const current = pending.pop()!;
		const v = current.value;
		if (current.leave) {
			active.delete(v as object);
			continue;
		}
		queuedNodes--;
		if (++nodes > 10_000 || current.depth > 64) return false;
		if (v === null || typeof v === "boolean") continue;
		if (typeof v === "number") {
			if (!Number.isFinite(v)) return false;
			continue;
		}
		if (typeof v === "string") {
			textUnits += v.length;
			if (textUnits > 100_000) return false;
			continue;
		}
		if (!v || typeof v !== "object" || active.has(v)) return false;
		if (
			!Array.isArray(v) &&
			Object.getPrototypeOf(v) !== Object.prototype &&
			Object.getPrototypeOf(v) !== null
		)
			return false;
		const keys = Object.keys(v);
		if (nodes + queuedNodes + keys.length > 10_000) return false;
		if (
			Array.isArray(v) &&
			(keys.length !== v.length ||
				keys.some((key, index) => key !== String(index)))
		)
			return false;
		active.add(v);
		pending.push({ value: v, depth: current.depth, leave: true });
		for (const key of keys) {
			textUnits += key.length;
			if (textUnits > 100_000) return false;
			const property = Object.getOwnPropertyDescriptor(v, key);
			if (!property || !("value" in property)) return false;
			pending.push({ value: property.value, depth: current.depth + 1 });
			queuedNodes++;
		}
	}
	return true;
}
