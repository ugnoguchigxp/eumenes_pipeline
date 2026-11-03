import type { ComponentRecord } from "./contracts/component.ts";

/** Locale-independent order: the same catalog gives the same order (and digest) everywhere. */
export const byCodeUnit = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

export type ResolveFailure =
	| "unknown_component"
	| "ambiguous_entry"
	| "entry_not_in_bundle"
	| "component_not_offered";

export type Resolved =
	| { ok: true; record: ComponentRecord }
	| { ok: false; code: ResolveFailure; candidates: string[] };

/**
 * The catalog a definition is checked against. It must be the same catalog whose cards were shown
 * to the composing AI (plan §4); `version` identifies it in plans and run records.
 */
export type CatalogView = {
	version: string;
	/** The records offered as components, in a stable order. */
	offered: readonly ComponentRecord[];
	/** Every record, offered or not, by entry; for evidence and error reporting. */
	all: ReadonlyMap<string, ComponentRecord>;
	resolve(bundle: string, entry?: string): Resolved;
};

/**
 * Resolution is by contract only (no name similarity, no implicit default entry):
 * - with `entry`: that entry, which must belong to `bundle` (or `bundle` names the entry itself);
 * - without: `bundle` names an entry, or a bundle with exactly one offered entry. A name that is
 *   both an entry and a bundle with several offered entries is ambiguous.
 */
export function createCatalogView(
	records: readonly ComponentRecord[],
	options: { version: string; offer: (record: ComponentRecord) => boolean },
): CatalogView {
	const all = new Map<string, ComponentRecord>();
	for (const record of records) {
		if (all.has(record.card.entry))
			throw new Error(`duplicate entry in catalog: ${record.card.entry}`);
		all.set(record.card.entry, record);
	}
	const offered = [...all.values()]
		.filter(options.offer)
		.sort((a, b) => byCodeUnit(a.card.entry, b.card.entry));
	const isOffered = new Set(offered.map((r) => r.card.entry));
	const fail = (code: ResolveFailure, candidates: string[] = []): Resolved => ({
		ok: false,
		code,
		candidates,
	});
	const take = (record: ComponentRecord): Resolved =>
		isOffered.has(record.card.entry)
			? { ok: true, record }
			: fail("component_not_offered");

	return {
		version: options.version,
		offered,
		all,
		resolve(bundle, entry) {
			if (entry !== undefined) {
				const record = all.get(entry);
				if (!record) return fail("unknown_component");
				if (record.card.bundle !== bundle && entry !== bundle)
					return fail("entry_not_in_bundle");
				return take(record);
			}
			const inBundle = offered.filter((r) => r.card.bundle === bundle);
			const named = all.get(bundle);
			if (named) {
				if (inBundle.length > 1)
					return fail(
						"ambiguous_entry",
						inBundle.map((r) => r.card.entry),
					);
				return take(named);
			}
			if (inBundle.length === 1 && inBundle[0]) return take(inBundle[0]);
			if (inBundle.length > 1)
				return fail(
					"ambiguous_entry",
					inBundle.map((r) => r.card.entry),
				);
			return [...all.values()].some((r) => r.card.bundle === bundle)
				? fail("component_not_offered")
				: fail("unknown_component");
		},
	};
}
