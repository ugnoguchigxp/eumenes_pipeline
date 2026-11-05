/** Evaluation protocol identity, separate from producer inputs. No semantic classification here. */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson, sha256, loadBenchCatalog } from "../catalog/load.ts";
import { sourceProvenance, captureCases } from "./provenance.ts";
import { loadCases, type EvalCase } from "./cases.ts";

const schema = z.strictObject({
	version: z.literal(1),
	id: z.string().min(1),
	createdAt: z.string(),
	sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
	policySha256: z.string(),
	caseSetSha256: z.string(),
	catalogVersion: z.string(),
	sessions: z
		.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
		.min(1)
		.refine(
			(sessions) => new Set(sessions).size === sessions.length,
			"sessions must be unique",
		),
	protocol: z.record(z.string(), z.unknown()),
	digest: z.string(),
});
export type EvaluationFreeze = z.infer<typeof schema>;

const catalogVersion = () => {
	const catalog = loadBenchCatalog();
	try {
		return catalog.view.version;
	} finally {
		catalog.close();
	}
};

export function assertSeparatedGroups(
	finalCases: readonly EvalCase[],
	diagnostics: readonly EvalCase[],
) {
	const ids = new Set(diagnostics.map((c) => c.id));
	const groups = new Set(
		diagnostics.flatMap((c) => (c.group ? [c.group] : [])),
	);
	for (const c of finalCases) {
		if (ids.has(c.id) || (c.group && groups.has(c.group)))
			throw new Error(`evaluation family overlaps diagnostics: ${c.id}`);
		if (c.split !== "holdout" || !c.group)
			throw new Error("final cases need an explicit holdout split and group");
	}
}

export function freezeEvaluation(options: {
	path: string;
	id: string;
	casesDir: string;
	policyPath: string;
	sessions: string[];
	protocol: Record<string, unknown>;
	diagnosticsDir?: string;
}) {
	const cases = loadCases(options.casesDir);
	if (!cases.length) throw new Error("cannot freeze an empty case set");
	if (options.protocol.intent === "recording-regrade") {
		if (cases.some((c) => c.split !== "dev"))
			throw new Error("recording regrades must label exposed cases as dev");
	} else assertSeparatedGroups(cases, loadCases(options.diagnosticsDir));
	const body = {
		version: 1 as const,
		id: options.id,
		createdAt: new Date().toISOString(),
		sourceSha256: sourceProvenance().sha256,
		policySha256: sha256(readFileSync(options.policyPath, "utf8")),
		caseSetSha256: captureCases(cases, options.casesDir).digest,
		catalogVersion: catalogVersion(),
		sessions: options.sessions,
		protocol: options.protocol,
	};
	const freeze = schema.parse({ ...body, digest: sha256(canonicalJson(body)) });
	writeFileSync(options.path, canonicalJson(freeze), {
		flag: "wx",
		mode: 0o600,
	});
	return freeze;
}

export function verifyFreeze(
	path: string,
	session: string,
	policyPath?: string,
	casesDir?: string,
) {
	const freeze = schema.parse(JSON.parse(readFileSync(path, "utf8")));
	const { digest, ...body } = freeze;
	if (sha256(canonicalJson(body)) !== digest)
		throw new Error("freeze manifest digest mismatch");
	if (!freeze.sessions.includes(session))
		throw new Error("session not in frozen protocol");
	if (sourceProvenance().sha256 !== freeze.sourceSha256)
		throw new Error("source changed after freeze");
	if (catalogVersion() !== freeze.catalogVersion)
		throw new Error("catalog changed after freeze");
	if (
		policyPath &&
		sha256(readFileSync(policyPath, "utf8")) !== freeze.policySha256
	)
		throw new Error("budget policy changed after freeze");
	if (
		casesDir &&
		captureCases(loadCases(casesDir), casesDir).digest !== freeze.caseSetSha256
	)
		throw new Error("cases changed after freeze");
	return freeze;
}
