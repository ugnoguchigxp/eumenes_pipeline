/**
 * Snapshot the Eumenes contracts the bench needs as JSON Schema, so this repository never imports
 * Eumenes at run time (plan §4, §7).
 *
 * Read-only: it imports Eumenes' contract modules and adapter descriptions in-process. It opens no
 * database, starts no server and writes nothing inside Eumenes.
 *
 *   bun scripts/extract-eumenes-contracts.ts [--eumenes ../eumenes] [--catalog <sqlite>] [--out <json>]
 *
 * What is captured
 * - `builtin:<key>`: every repository validator (`validators` in capabilities/contracts), as input JSON Schema.
 * - `domain:<ref>`: every domain result schema a binding in the catalog snapshot names, resolved through the
 *   host's own schema provider, as output JSON Schema.
 * - `adapters`: each host adapter's operations (input schema ref, read/write effect), queries, projections.
 *
 * Limits recorded in the output: Zod refinements and transforms are not representable in JSON Schema, so
 * the bench checks structure only; the authoritative check stays in Eumenes.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		eumenes: { type: "string", default: "../eumenes" },
		catalog: {
			type: "string",
			default: "data/source/eumenes-catalog-2026-11-03.sqlite3",
		},
		out: {
			type: "string",
			default: "data/contracts/eumenes-contracts-2026-11-03.json",
		},
	},
});
const root = resolve(values.eumenes);
const contractsPath = join(root, "api/domains/capabilities/contracts/index.ts");
const adaptersPath = join(
	root,
	"api/application/toolchain/toolchain-adapters.ts",
);
for (const path of [contractsPath, adaptersPath])
	if (!existsSync(path)) throw new Error(`not an Eumenes checkout: ${path}`);

type ZodLike = { _zod: unknown };
type ZodModule = {
	toJSONSchema(schema: unknown, params?: Record<string, unknown>): unknown;
	version?: unknown;
};
// The schemas must be converted by the same Zod instance that built them.
const zod = (await import(Bun.resolveSync("zod", root))) as ZodModule & {
	z?: ZodModule;
};
const z: ZodModule = zod.z ?? zod;
const zodVersion = (
	(await Bun.file(
		join(dirname(Bun.resolveSync("zod/package.json", root)), "package.json"),
	).json()) as { version: string }
).version;

const { validators } = (await import(contractsPath)) as {
	validators: Record<string, ZodLike>;
};
const adapters = (await import(adaptersPath)) as {
	createSchemaProvider(capabilities: unknown): {
		get(ref: string): ZodLike | undefined;
	};
	hostAdapterDescriptions: Array<{ ref: string; describe(): unknown }>;
};
// `domain:` and `builtin:` refs resolve without capabilities; only `schema:` refs need the database.
const provider = adapters.createSchemaProvider({});

type Converted = { jsonSchema: unknown; unrepresentable: boolean };
function convert(schema: ZodLike, io: "input" | "output"): Converted {
	try {
		return {
			jsonSchema: z.toJSONSchema(schema, {
				io,
				target: "draft-2020-12",
				unrepresentable: "throw",
			}),
			unrepresentable: false,
		};
	} catch {
		return {
			jsonSchema: z.toJSONSchema(schema, {
				io,
				target: "draft-2020-12",
				unrepresentable: "any",
			}),
			unrepresentable: true,
		};
	}
}

const builtin: Record<string, Converted> = {};
for (const key of Object.keys(validators).sort()) {
	const schema = validators[key];
	if (schema) builtin[`builtin:${key}`] = convert(schema, "input");
}

// The snapshot must be the one its manifest describes (same rule as bench/catalog/snapshot.ts).
const catalogPath = resolve(values.catalog);
const catalogManifest = JSON.parse(
	await Bun.file(catalogPath.replace(/\.sqlite3$/, ".manifest.json")).text(),
) as { sha256: string };
const catalogSha256 = createHash("sha256")
	.update(new Uint8Array(await Bun.file(catalogPath).arrayBuffer()))
	.digest("hex");
if (catalogSha256 !== catalogManifest.sha256)
	throw new Error(
		`catalog snapshot digest mismatch: ${catalogSha256} != manifest ${catalogManifest.sha256}`,
	);
const catalog = new Database(`${pathToFileURL(catalogPath).href}?immutable=1`, {
	readonly: true,
});
const domainRefs = new Set<string>();
for (const row of catalog
	.query<{ document_json: string }, []>(
		"SELECT document_json FROM capability_documents WHERE kind = 'binding'",
	)
	.all()) {
	const ref = (JSON.parse(row.document_json) as { outputSchemaRef?: unknown })
		.outputSchemaRef;
	if (typeof ref === "string" && ref.startsWith("domain:")) domainRefs.add(ref);
}
catalog.close();
const domain: Record<string, Converted> = {};
const unresolved: string[] = [];
for (const ref of [...domainRefs].sort()) {
	const schema = provider.get(ref);
	if (schema) domain[ref] = convert(schema, "output");
	else unresolved.push(ref);
}

type Description = {
	owner?: string;
	operations?: Map<string, { inputSchemaRef: string; effect: string }>;
	queries?: Set<string>;
	projections?: Set<string>;
	availability?: string;
};
const adapterDescriptions: Record<string, unknown> = {};
for (const { ref, describe } of adapters.hostAdapterDescriptions) {
	try {
		const d = describe() as Description;
		adapterDescriptions[ref] = {
			owner: d.owner ?? null,
			availability: d.availability ?? null,
			operations: [...(d.operations ?? new Map()).entries()]
				.map(([operationId, op]) => ({
					operationId,
					inputSchemaRef: op.inputSchemaRef,
					effect: op.effect,
				}))
				.sort((a, b) =>
					a.operationId < b.operationId
						? -1
						: a.operationId > b.operationId
							? 1
							: 0,
				),
			queries: [...(d.queries ?? [])].sort(),
			projections: [...(d.projections ?? [])].sort(),
		};
	} catch (error) {
		adapterDescriptions[ref] = { error: String(error) };
	}
}

const git = (args: string[]) => {
	const r = Bun.spawnSync(["git", "-C", root, ...args]);
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const sourceDirty = git(["status", "--porcelain", "--", "api"]);
const snapshot = {
	formatVersion: 1,
	source: {
		repository: relative(process.cwd(), root),
		gitCommit: git(["rev-parse", "HEAD"]),
		apiDirty: sourceDirty === null ? null : sourceDirty.length > 0,
		zodVersion,
		catalog: relative(process.cwd(), catalogPath),
		catalogSha256,
	},
	limits: [
		"Zod refinements, transforms and custom checks are not represented; the bench checks structure only.",
		"`unrepresentable: true` marks a schema where an unrepresentable part was widened to `{}` (any).",
		"`schema:` refs are bundle JSON Schemas stored in the catalog snapshot itself and are read from there.",
	],
	builtin,
	domain,
	unresolvedDomainRefs: unresolved,
	adapters: adapterDescriptions,
};
const body = `${JSON.stringify(snapshot, null, "\t")}\n`;
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body);
const sha256 = createHash("sha256").update(body).digest("hex");
writeFileSync(
	out.replace(/\.json$/, ".manifest.json"),
	`${JSON.stringify(
		{
			snapshotKind: "eumenes-contracts-json-schema",
			file: relative(dirname(out), out),
			createdAt: new Date().toISOString(),
			sha256,
			counts: {
				builtin: Object.keys(builtin).length,
				domain: Object.keys(domain).length,
				unresolvedDomainRefs: unresolved.length,
				adapters: Object.keys(adapterDescriptions).length,
				unrepresentable: [
					...Object.values(builtin),
					...Object.values(domain),
				].filter((c) => c.unrepresentable).length,
			},
			source: snapshot.source,
		},
		null,
		"\t",
	)}\n`,
);
console.log(
	`wrote ${relative(process.cwd(), out)}: ${Object.keys(builtin).length} builtin, ${Object.keys(domain).length} domain, ${unresolved.length} unresolved, ${Object.keys(adapterDescriptions).length} adapters (sha256 ${sha256.slice(0, 12)})`,
);
