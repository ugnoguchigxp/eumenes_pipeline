/** Prepare the same blinded requests later reconstructed by the quality report. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBenchCatalog, canonicalJson } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import { captureCases } from "../cases/provenance.ts";
import { verifyFreeze } from "../cases/freeze.ts";
import { buildRecordedJudgeRequest, JUDGE_VERSION } from "./judge.ts";
import { inferenceDigest, RecordedInference } from "../infer/recorded.ts";
import { recordPreparedRequests } from "../infer/prepared.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";

export function prepareJudgements(options: {
	source: string;
	session: string;
	casesDir?: string;
	nativeSchema?: boolean;
	freezePath?: string;
	dbPath?: string;
	runsRoot?: string;
}) {
	if (
		![options.source, options.session].every((s) =>
			/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s),
		)
	)
		throw new Error("invalid judge session");
	const frozen = options.freezePath
		? verifyFreeze(
				options.freezePath,
				options.session,
				undefined,
				options.casesDir,
			)
		: undefined;
	if (frozen) {
		const spec = (
				frozen.protocol.apiSessions as Record<
					string,
					{ source?: string; phase: string }
				>
			)[options.session],
			judge = frozen.protocol.judge as {
				nativeSchema?: boolean;
				version?: string;
				mode?: string;
			};
		if (
			spec?.source !== options.source ||
			spec.phase !== "judge" ||
			!!judge.nativeSchema !== !!options.nativeSchema ||
			(judge.version && judge.version !== JUDGE_VERSION) ||
			(judge.mode && judge.mode !== "plan")
		)
			throw new Error("judge preparation differs from frozen protocol");
	}
	const root = options.runsRoot ?? "data/runs/format";
	const sources = RecordedInference.fromDirectory(
		join(root, options.source, "recordings"),
	);
	const cases = loadCases(options.casesDir);
	// A default cases directory must also be checked when --cases is omitted.
	if (
		frozen &&
		captureCases(cases, options.casesDir).digest !== frozen.caseSetSha256
	)
		throw new Error("cases changed after freeze");
	const byId = new Map(cases.map((c) => [c.id, c]));
	const catalog = loadBenchCatalog();
	const work = openWorkDb(options.dbPath ?? DEFAULT_WORK_DB);
	try {
		const sourceRun = work.db
			.query<{ config_json: string }, [string]>(
				"SELECT config_json FROM runs WHERE kind='format' AND status='completed' AND json_extract(config_json,'$.session')=? ORDER BY rowid DESC LIMIT 1",
			)
			.get(options.source);
		const sourceConfig = sourceRun ? JSON.parse(sourceRun.config_json) : null;
		if (frozen && sourceConfig?.freezeDigest !== frozen.digest)
			throw new Error(
				"judge source was not prepared under the frozen protocol",
			);
		const condition = sourceRun
			? sourceConfig.condition
			: (
					frozen?.protocol.formatMethod as
						{ condition?: { promptStyle?: string } } | undefined
				)?.condition;
		const hostReading = condition?.promptStyle === "eumenes-p0-3";
		const dir = join(root, options.session, "judge-requests");
		const prepared = [...sources.files].map(([name, recording]) => {
			const c = byId.get(name.replace(/--[^.]+\.json$/, ""));
			if (!c) throw new Error("missing source case");
			const request = buildRecordedJudgeRequest({
				request: c.request,
				providedMaterials: c.providedMaterials,
				cards: catalog.cards,
				catalog: catalog.view,
				output: recording.output,
				nativeSchema: !!options.nativeSchema,
				hostReading,
			});
			const promptDigest = inferenceDigest(request),
				content = canonicalJson({ ...request, promptDigest }),
				target = join(dir, name);
			if (existsSync(target) && readFileSync(target, "utf8") !== content)
				throw new Error("judge session already has different requests");
			return { name, promptDigest, content, target };
		});
		mkdirSync(dir, { recursive: true });
		for (const p of prepared)
			if (!existsSync(p.target))
				writeFileSync(p.target, p.content, { flag: "wx", mode: 0o600 });
		if (frozen) {
			recordPreparedRequests(work, {
				session: options.session,
				freezeDigest: frozen.digest,
				requests: prepared.map((p) => ({
					phase: "judge",
					name: p.name,
					promptDigest: p.promptDigest,
				})),
			});
		}
		return {
			session: options.session,
			prepared: prepared.length,
			judgeVersion: JUDGE_VERSION,
		};
	} finally {
		work.close();
		catalog.close();
	}
}
