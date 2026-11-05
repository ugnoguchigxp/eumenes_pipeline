import { verifyPreparedRequests } from "./prepared.ts";
import { verifyFreeze } from "../cases/freeze.ts";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import { apiBudget } from "../store/api-budget.ts";
import { DEFAULT_WORK_DB, openWorkDb } from "../store/work-db.ts";
import { ApiInference, apiProfile, type ApiEvidence } from "./api.ts";
import { apiCredential, type ApiProvider } from "./api-config.ts";
import { inferenceDigest } from "./recorded.ts";

const policySchema = z
	.strictObject({
		id: z.string().min(1),
		ceilingUsd: z.number().positive().max(10),
		approvedCeilingUsd: z.number().positive().max(10),
		maxOutputTokens: z.number().int().positive().max(8192),
		timeoutMs: z.number().int().positive().max(300_000),
		profiles: z.array(apiProfile).min(1),
		note: z.string(),
	})
	.refine(
		(p) => p.ceilingUsd <= p.approvedCeilingUsd,
		"policy exceeds user approval",
	);
const requestSchema = z.object({
	purpose: z.string().min(1),
	system: z.string().optional(),
	prompt: z.string(),
	promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
	outputSchema: z.record(z.string(), z.unknown()).optional(),
});
const phases = {
	compose: ["requests", "recordings"],
	repair: ["repair-requests", "repair-recordings"],
	judge: ["judge-requests", "judge-recordings"],
} as const;

export async function runApiInference(options: {
	provider: ApiProvider;
	model: string;
	session: string;
	budgetPath: string;
	freezePath?: string;
	phase?: keyof typeof phases;
	dbPath?: string;
	runsRoot?: string;
	caseIds?: readonly string[];
	env?: Record<string, string | undefined>;
	fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.session))
		throw new Error("invalid session name");
	const freeze = options.freezePath
		? verifyFreeze(options.freezePath, options.session, options.budgetPath)
		: undefined;
	const policy = policySchema.parse(
		JSON.parse(readFileSync(options.budgetPath, "utf8")),
	);
	const profile = policy.profiles.find(
		(p) => p.provider === options.provider && p.model === options.model,
	);
	if (!profile) throw new Error("model is not in the frozen budget policy");
	const credential = apiCredential(options.provider, options.env);
	const phase = options.phase ?? "compose";
	if (freeze) {
		const specs = freeze.protocol.apiSessions as
			| Record<string, { provider: string; model: string; phase: string }>
			| undefined;
		const spec = specs?.[options.session];
		if (
			!spec ||
			spec.provider !== options.provider ||
			spec.model !== options.model ||
			spec.phase !== phase
		)
			throw new Error("API condition differs from frozen session");
	}
	const session = join(options.runsRoot ?? "data/runs/format", options.session);
	const requestsDir = join(session, phases[phase][0]);
	const recordingsDir = join(session, phases[phase][1]);
	const files = readdirSync(requestsDir)
		.filter((f) => /^[a-z0-9][a-z0-9._-]{0,99}\.json$/.test(f))
		.sort();
	const prepared = files
		.filter(
			(name) =>
				!options.caseIds ||
				options.caseIds.includes(name.replace(/--[^.]+\.json$/, "")),
		)
		.map((name) => {
			if (existsSync(join(recordingsDir, name)))
				throw new Error(`recording already exists: ${name}; use a new session`);
			const bytes = readFileSync(join(requestsDir, name), "utf8");
			const request = requestSchema.parse(JSON.parse(bytes));
			if (
				request.purpose !== phase ||
				inferenceDigest(request) !== request.promptDigest
			)
				throw new Error(`request digest or purpose mismatch: ${name}`);
			return { name, request, sha256: sha256(bytes) };
		});
	if (freeze) {
		const specs = freeze.protocol.apiSessions as Record<
			string,
			{ requestCount: number }
		>;
		if (prepared.length !== specs[options.session]?.requestCount)
			throw new Error("request count differs from frozen session");
	}
	if (!prepared.length) throw new Error("no matching inference requests");
	const work = openWorkDb(options.dbPath ?? DEFAULT_WORK_DB);
	try {
		if (freeze)
			verifyPreparedRequests(work, freeze, options.session, phase, prepared);
		const budget = apiBudget(work.db, policy.id, policy.ceilingUsd);
		const runId = work.startRun({
			kind: "api-inference",
			config: {
				evidence: "api",
				execution: "live",
				provider: options.provider,
				model: profile.model,
				policy,
				credentialVariable: credential.name,
				session: options.session,
				phase,
			},
			inputs: {
				...(freeze ? { freezeDigest: freeze.digest } : {}),
				requests: prepared.map(({ name, request, sha256 }) => ({
					name,
					sha256,
					promptDigest: request.promptDigest,
				})),
			},
		});
		const evidenceDir = join(session, "api-evidence", runId);
		const provenanceDir = join(session, "api-provenance", phases[phase][1]);
		const results: { file: string; ok: boolean; error?: string }[] = [];
		let completed = false;
		try {
			mkdirSync(evidenceDir, { recursive: true });
			mkdirSync(provenanceDir, { recursive: true });
			mkdirSync(recordingsDir, { recursive: true });
			for (const cell of prepared) {
				const trialId = work.startTrial({
					runId,
					caseId: cell.name,
					condition: `${options.provider}/${options.model}`,
					attempt: 1,
					phase,
				});
				let evidence: ApiEvidence | undefined;
				try {
					const port = new ApiInference(profile, {
						budget,
						maxOutputTokens: policy.maxOutputTokens,
						timeoutMs: policy.timeoutMs,
						...(options.env ? { env: options.env } : {}),
						...(options.fetcher ? { fetcher: options.fetcher } : {}),
						onEvidence: (value) => {
							evidence = value;
							writeFileSync(
								join(evidenceDir, cell.name),
								canonicalJson(value),
								{
									flag: "wx",
									mode: 0o600,
								},
							);
						},
					});
					const result = await port.complete(cell.request);
					work.recordModelCall(trialId, phase, result);
					if (!result.ok) {
						work.finishTrial(trialId, {
							status: "failed",
							error: result.error,
						});
						results.push({ file: cell.name, ok: false, error: result.error });
						break;
					}
					const record = {
						evidence: "api",
						promptDigest: cell.request.promptDigest,
						output: result.text,
					};
					writeFileSync(join(recordingsDir, cell.name), canonicalJson(record), {
						flag: "wx",
						mode: 0o600,
					});
					writeFileSync(
						join(provenanceDir, cell.name),
						canonicalJson({
							version: 1,
							evidence: "api",
							runId,
							trialId,
							provider: options.provider,
							model: result.model,
							usage: result.usage,
							durationMs: result.durationMs,
							promptDigest: cell.request.promptDigest,
							outputDigest: sha256(result.text),
							requestId: evidence?.requestId ?? null,
							outputSchemaDigest:
								cell.request.outputSchema === undefined
									? null
									: sha256(canonicalJson(cell.request.outputSchema)),
						}),
						{ flag: "wx", mode: 0o600 },
					);
					work.finishTrial(trialId, {
						status: "completed",
						outputText: result.text,
					});
					results.push({ file: cell.name, ok: true });
				} catch (error) {
					const message =
						error instanceof Error
							? error.message.replaceAll(credential.key, "[REDACTED]")
							: "inference failed";
					work.finishTrial(trialId, { status: "failed", error: message });
					results.push({ file: cell.name, ok: false, error: message });
					break;
				}
			}
			completed =
				results.length === prepared.length && results.every((r) => r.ok);
			const report = {
				runId,
				provider: options.provider,
				model: profile.model,
				phase,
				requested: prepared.length,
				completed,
				results,
				budget: budget.status(),
			};
			writeFileSync(join(evidenceDir, "report.json"), canonicalJson(report), {
				flag: "wx",
				mode: 0o600,
			});
			return report;
		} finally {
			work.finishRun(runId, completed ? "completed" : "failed");
		}
	} finally {
		work.close();
	}
}
