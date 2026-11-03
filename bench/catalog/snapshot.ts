/**
 * Read-only access to the catalog snapshot copied from Eumenes (plan §4).
 *
 * The snapshot is evidence: it is opened `immutable` and read-only, and its SHA-256 must match the
 * manifest written when it was copied. Anything the bench derives (indexes, mock calls, results)
 * goes to the work database (`bench/store/work-db.ts`), never into this file.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SNAPSHOT =
	"data/source/eumenes-catalog-2026-11-03.sqlite3";

export type SnapshotManifest = {
	sha256: string;
	createdAt: string;
	tables: Record<string, number>;
	toolchains: number;
	enabledToolchains: number;
};

export type Item = {
	key: string;
	id: string;
	kind: string;
	activeRevisionId: string;
	enabled: boolean;
};

export type Revision<T = Record<string, unknown>> = {
	id: string;
	itemKey: string;
	revision: number;
	definition: T;
	definitionHash: string;
};

export type CatalogDocument<T = Record<string, unknown>> = {
	id: string;
	kind: "binding" | "http-binding" | "artifact" | "schema";
	itemId: string;
	revision: number;
	digest: string;
	document: T;
	bundleId: string;
};

export type Snapshot = {
	path: string;
	sha256: string;
	manifest: SnapshotManifest;
	items(kind: string): Item[];
	item(kind: string, id: string): Item | null;
	revision<T = Record<string, unknown>>(id: string): Revision<T> | null;
	/** `binding:compute.command@1` style revision ids of documents. */
	document<T = Record<string, unknown>>(
		revisionId: string,
	): CatalogDocument<T> | null;
	vectors(revisionId: string): Array<{
		item: number;
		space: string;
		textDigest: string;
		vector: Float32Array;
	}>;
	close(): void;
};

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parse `kind:id@revision`. */
export function parseRevisionId(
	revisionId: string,
): { kind: string; id: string; revision: number } | null {
	const match = /^([a-z-]+):(.+)@(\d+)$/.exec(revisionId);
	if (!match?.[1] || !match[2] || !match[3]) return null;
	return { kind: match[1], id: match[2], revision: Number(match[3]) };
}

export function openSnapshot(
	path: string = DEFAULT_SNAPSHOT,
	options: { manifestPath?: string; verify?: boolean } = {},
): Snapshot {
	const absolute = resolve(path);
	const manifestPath =
		options.manifestPath ?? absolute.replace(/\.sqlite3$/, ".manifest.json");
	const manifest = JSON.parse(
		readFileSync(manifestPath, "utf8"),
	) as SnapshotManifest;
	const sha256 = sha256File(absolute);
	if (options.verify !== false && sha256 !== manifest.sha256)
		throw new Error(
			`catalog snapshot digest mismatch: ${sha256} != manifest ${manifest.sha256}`,
		);
	// `immutable=1` makes SQLite skip locking and WAL handling: the file is never written.
	const db = new Database(`${pathToFileURL(absolute).href}?immutable=1`, {
		readonly: true,
		strict: true,
	});

	type ItemRow = {
		key: string;
		id: string;
		kind: string;
		active_revision_id: string;
		enabled: number;
	};
	const toItem = (row: ItemRow): Item => ({
		key: row.key,
		id: row.id,
		kind: row.kind,
		activeRevisionId: row.active_revision_id,
		enabled: row.enabled === 1,
	});
	const itemsQuery = db.query<ItemRow, [string]>(
		"SELECT key, id, kind, active_revision_id, enabled FROM capability_items WHERE kind = ? ORDER BY id",
	);
	const itemQuery = db.query<ItemRow, [string, string]>(
		"SELECT key, id, kind, active_revision_id, enabled FROM capability_items WHERE kind = ? AND id = ?",
	);
	const revisionQuery = db.query<
		{
			id: string;
			item_key: string;
			revision: number;
			definition_json: string;
			definition_hash: string;
		},
		[string]
	>(
		"SELECT id, item_key, revision, definition_json, definition_hash FROM capability_revisions WHERE id = ?",
	);
	const documentQuery = db.query<
		{
			id: string;
			kind: CatalogDocument["kind"];
			item_id: string;
			revision: number;
			digest: string;
			document_json: string;
			bundle_id: string;
		},
		[string, string, number]
	>(
		"SELECT id, kind, item_id, revision, digest, document_json, bundle_id FROM capability_documents WHERE kind = ? AND item_id = ? AND revision = ?",
	);
	const vectorQuery = db.query<
		{ item: number; space: string; text_digest: string; vector: Uint8Array },
		[string]
	>(
		"SELECT item, space, text_digest, vector FROM capability_toolchain_vectors WHERE revision_id = ? ORDER BY item, space",
	);

	return {
		path: absolute,
		sha256,
		manifest,
		items: (kind) => itemsQuery.all(kind).map(toItem),
		item(kind, id) {
			const row = itemQuery.get(kind, id);
			return row ? toItem(row) : null;
		},
		revision<T>(id: string) {
			const row = revisionQuery.get(id);
			if (!row) return null;
			return {
				id: row.id,
				itemKey: row.item_key,
				revision: row.revision,
				definition: JSON.parse(row.definition_json) as T,
				definitionHash: row.definition_hash,
			};
		},
		document<T>(revisionId: string) {
			const parsed = parseRevisionId(revisionId);
			if (!parsed) return null;
			const row = documentQuery.get(parsed.kind, parsed.id, parsed.revision);
			if (!row) return null;
			return {
				id: row.id,
				kind: row.kind,
				itemId: row.item_id,
				revision: row.revision,
				digest: row.digest,
				document: JSON.parse(row.document_json) as T,
				bundleId: row.bundle_id,
			};
		},
		vectors: (revisionId) =>
			vectorQuery.all(revisionId).map((row) => ({
				item: row.item,
				space: row.space,
				textDigest: row.text_digest,
				// Copy: the blob buffer is not guaranteed to be 4-byte aligned.
				vector: new Float32Array(new Uint8Array(row.vector).buffer),
			})),
		close: () => db.close(),
	};
}
