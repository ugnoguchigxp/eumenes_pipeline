/** Local, evaluator-only evidence. Contains synthetic benchmark data, never credentials. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	existsSync,
	chmodSync,
	mkdirSync,
	readFileSync,
	lstatSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { z } from "zod";
import { RecordedInference } from "../infer/recorded.ts";
import { verifyApiRecording } from "../infer/provenance.ts";
import { canonicalJson } from "../catalog/load.ts";
import { readCaseSnapshot, sourceProvenance } from "../cases/provenance.ts";

const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const manifestSchema = z.strictObject({
	version: z.literal(1),
	runId: z.string(),
	sourceSha256: z.string(),
	files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

export function createEvidenceBundle(options: {
	runId: string;
	dbPath: string;
	target: string;
	root?: string;
	runsRoot?: string;
}) {
	const root = options.root ?? resolve(import.meta.dir, "../..");
	const db = new Database(options.dbPath, { readonly: true, strict: true });
	try {
		const row = db
			.query<
				{ inputs_json: string; config_json: string; status: string },
				[string]
			>("SELECT inputs_json, config_json, status FROM runs WHERE run_id = ?")
			.get(options.runId);
		if (!row) throw new Error("unknown run");
		if (row.status !== "completed")
			throw new Error("bundle requires a completed run");
		const inputs = JSON.parse(row.inputs_json);
		const config = JSON.parse(row.config_json);
		const source = sourceProvenance(root);
		if (inputs.source?.sha256 !== source.sha256)
			throw new Error(
				"source changed since run; preserve original source before bundling",
			);
		const { snapshot } = readCaseSnapshot(inputs.caseSnapshot);
		if (
			typeof config.session !== "string" ||
			!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.session)
		)
			throw new Error("unsupported session");
		if (existsSync(options.target))
			throw new Error("bundle target already exists");
		mkdirSync(options.target, { recursive: false });
		const files: Record<string, string> = {};
		const save = (path: string, bytes: Uint8Array) => {
			files[path] = hash(bytes);
			mkdirSync(dirname(join(options.target, path)), { recursive: true });
			writeFileSync(join(options.target, path), bytes, {
				flag: "wx",
				mode: 0o600,
			});
		};
		const text = (path: string, content: string) =>
			save(path, Buffer.from(content));
		for (const path of Object.keys(source.files))
			save(path, readFileSync(join(root, path)));
		for (const file of snapshot.files)
			text(`data/replay-cases/${file.id}.json`, file.content);
		const copyTree = (
			from: string,
			to: string,
			accept: (p: string) => boolean,
		) => {
			for (const entry of readdirSync(from, { withFileTypes: true })) {
				const dest = `${to}/${entry.name}`;
				const src = join(from, entry.name);
				if (entry.isSymbolicLink())
					throw new Error("symlink in evidence source");
				if (entry.isDirectory()) copyTree(src, dest, accept);
				else if (entry.isFile() && accept(dest)) save(dest, readFileSync(src));
			}
		};
		for (const dir of ["data/source", "data/contracts", "vendor/router"])
			copyTree(join(root, dir), dir, (p) => /\.(json|sqlite3|tgz)$/.test(p));
		const runsRoot = options.runsRoot ?? join(root, "data/runs/format");
		const session = join(runsRoot, config.session);
		copyTree(
			session,
			`data/runs/format/${config.session}`,
			(p) => p.endsWith(".json") && !p.endsWith("/summary.json"),
		);

		// A derived session may point to API calls prepared in another session. Preserve
		// those exact original requests as well, so provenance remains independently verifiable.
		for (const phase of ["compose", "repair"] as const) {
			const dir = phase === "compose" ? "recordings" : "repair-recordings";
			const records = RecordedInference.fromDirectory(join(session, dir));
			for (const [file, source] of records.provenance) {
				const { requestPath } = verifyApiRecording({
					db,
					runsRoot,
					file,
					source,
					recording: records.files.get(file)!,
					provider: source.provider,
					model: source.model,
					phase,
				});
				const relativePath = relative(runsRoot, requestPath);
				const path = `data/runs/format/${relativePath}`;
				if (!files[path]) save(path, readFileSync(requestPath));
			}
		}
		// A raw serialize of a WAL database retains the WAL header and may not open
		// independently. VACUUM INTO creates a consistent, standalone SQLite file.
		const dbFile = join(options.target, "data/replay-source.sqlite3");
		db.query("VACUUM INTO ?").run(dbFile);
		chmodSync(dbFile, 0o600);
		files["data/replay-source.sqlite3"] = hash(readFileSync(dbFile));
		text(
			"replay.json",
			canonicalJson({
				runId: options.runId,
				config,
				inputs,
				caseIds: snapshot.files.map((f) => f.id),
			}),
		);
		// A missing manifest always means an incomplete bundle; it is written last.
		const manifest = {
			version: 1 as const,
			runId: options.runId,
			sourceSha256: source.sha256,
			files,
		};
		writeFileSync(
			join(options.target, "evidence-manifest.json"),
			canonicalJson(manifest),
			{ flag: "wx", mode: 0o600 },
		);
		return manifest;
	} finally {
		db.close();
	}
}

/** Verify every file before extraction/execution, rejecting paths outside the bundle. */
export function verifyEvidenceBundle(bundle: string) {
	const manifest = manifestSchema.parse(
		JSON.parse(readFileSync(join(bundle, "evidence-manifest.json"), "utf8")),
	);
	for (const [path, expected] of Object.entries(manifest.files)) {
		if (
			!/^[a-zA-Z0-9_./@-]+$/.test(path) ||
			path.startsWith("/") ||
			path.split("/").some((p) => p === ".." || p === ".")
		)
			throw new Error("unsafe bundle path");
		let current = bundle;
		for (const part of path.split("/")) {
			current = join(current, part);
			if (lstatSync(current).isSymbolicLink())
				throw new Error("symlink in evidence bundle");
		}
		if (hash(readFileSync(join(bundle, path))) !== expected)
			throw new Error(`bundle digest mismatch: ${path}`);
	}
	if (sourceProvenance(bundle).sha256 !== manifest.sourceSha256)
		throw new Error("bundle source identity mismatch");
	return manifest;
}
