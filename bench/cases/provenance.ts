/** Evaluator-only input snapshots. Never send these records to a producer or a mock. */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import { DEFAULT_CASES_DIR, evalCase, type EvalCase } from "./cases.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.strictObject({
	version: z.literal(1),
	digest,
	files: z.array(
		z.strictObject({ id: z.string(), sha256: digest, content: z.string() }),
	),
});
export type CaseSnapshot = z.infer<typeof snapshotSchema>;

export function captureCases(
	cases: readonly EvalCase[],
	dir = DEFAULT_CASES_DIR,
): CaseSnapshot {
	const files = cases.map((c) => {
		const content = readFileSync(join(dir, `${c.id}.json`), "utf8");
		const onDisk = evalCase.parse(JSON.parse(content));
		if (canonicalJson(onDisk) !== canonicalJson(c))
			throw new Error(`case changed while preparing run: ${c.id}`);
		return { id: c.id, sha256: sha256(content), content };
	});
	return { version: 1, digest: sha256(canonicalJson(files)), files };
}

export function readCaseSnapshot(value: unknown): {
	snapshot: CaseSnapshot;
	cases: EvalCase[];
} {
	const snapshot = snapshotSchema.parse(value);
	if (snapshot.digest !== sha256(canonicalJson(snapshot.files)))
		throw new Error("case snapshot digest mismatch");
	const ids = new Set<string>();
	const cases = snapshot.files.map((file) => {
		if (file.sha256 !== sha256(file.content))
			throw new Error(`case snapshot file digest mismatch: ${file.id}`);
		const c = evalCase.parse(JSON.parse(file.content));
		if (c.id !== file.id || ids.has(file.id))
			throw new Error(`case snapshot id mismatch or duplicate: ${file.id}`);
		ids.add(file.id);
		return c;
	});
	return { snapshot, cases };
}

/** Content identity, including dirty worktrees, without invoking Git or reading secrets. */
export function sourceProvenance(root = resolve(import.meta.dir, "../..")) {
	const files: Record<string, string> = {};
	const collect = (dir: string) => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) collect(path);
			else if (entry.isFile() && /\.(ts|py)$/.test(entry.name))
				files[path] = sha256(readFileSync(join(root, path), "utf8"));
		}
	};
	for (const dir of ["src", "bench", "scripts"]) collect(dir);
	for (const path of [
		"package.json",
		"bun.lock",
		"bunfig.toml",
		"tsconfig.json",
		"tsconfig.build.json",
		"README.md",
		"LICENSE",
	])
		files[path] = sha256(readFileSync(join(root, path), "utf8"));
	return { version: 1, sha256: sha256(canonicalJson(files)), files };
}
