/**
 * One call that gives an experiment the verified snapshot, contracts, inventory and the catalog view
 * the composing AI and the checker share (plan §4: the cards shown and the catalog checked are one).
 */
import { createHash } from "node:crypto";
import {
	byCodeUnit,
	createCatalogView,
	isRunnable,
	type CatalogView,
} from "../../src/catalog.ts";
import type {
	ComponentCard,
	ComponentRecord,
} from "../../src/contracts/component.ts";
import { loadContracts, type ContractSet } from "./contracts.ts";
import { buildInventory } from "./inventory.ts";
import { DEFAULT_SNAPSHOT, openSnapshot, type Snapshot } from "./snapshot.ts";

/** `ready`: catalog/code contracts only. `ready+partial`: also fixture or summary-only outputs. */
export type OfferPolicy = "ready" | "ready+partial";

export type BenchCatalog = {
	snapshot: Snapshot;
	contracts: ContractSet;
	records: ComponentRecord[];
	view: CatalogView;
	/** The cards offered to the composing AI, in the view's order. */
	cards: ComponentCard[];
	policy: OfferPolicy;
	close(): void;
};

/** Stable JSON (sorted keys) for digests. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						byCodeUnit(a, b),
					),
				)
			: v,
	);
}

export const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

export function loadBenchCatalog(
	options: {
		snapshotPath?: string;
		contractsPath?: string;
		fixturesPath?: string;
		policy?: OfferPolicy;
	} = {},
): BenchCatalog {
	const snapshot = openSnapshot(options.snapshotPath ?? DEFAULT_SNAPSHOT);
	const contracts = loadContracts(snapshot, {
		...(options.contractsPath ? { contractsPath: options.contractsPath } : {}),
		...(options.fixturesPath ? { fixturesPath: options.fixturesPath } : {}),
	});
	const records = buildInventory(snapshot, contracts);
	const policy = options.policy ?? "ready+partial";
	// The same rule as the library view, so the cards (and the version) are what it offers.
	const offer = (record: ComponentRecord) =>
		isRunnable(record) &&
		(record.support === "ready" ||
			(policy === "ready+partial" && record.support === "partial"));
	const offeredCards = records
		.filter(offer)
		.map((r) => r.card)
		.sort((a, b) => byCodeUnit(a.entry, b.entry));
	// The version covers what the AI sees and what the checker accepts, plus the evidence digests.
	const version = sha256(
		canonicalJson({
			snapshot: snapshot.sha256,
			contracts: contracts.contractsSha256,
			fixtures: contracts.fixturesSha256,
			policy,
			cards: offeredCards,
		}),
	);
	const view = createCatalogView(records, { version, offer });
	return {
		snapshot,
		contracts,
		records,
		view,
		cards: view.offered.map((r) => r.card),
		policy,
		close: () => snapshot.close(),
	};
}
