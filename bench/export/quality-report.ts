/** Frozen mechanical/semantic aggregation. Runs locally without inference. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, loadBenchCatalog, sha256 } from "../catalog/load.ts";
import { verifyFreeze } from "../cases/freeze.ts";
import { readCaseSnapshot } from "../cases/provenance.ts";
import { buildRunExport } from "./export.ts";
import { RecordedInference, inferenceDigest } from "../infer/recorded.ts";
import { verifyApiRecording } from "../infer/provenance.ts";
import {
	buildRecordedJudgeRequest,
	parseJudgement,
	type Judgement,
} from "../scoring/judge.ts";
import { apiBudget } from "../store/api-budget.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";
export function runQualityReport(options: {
	freezePath: string;
	budgetPath: string;
	out: string;
	dbPath?: string;
	runsRoot?: string;
}) {
	const frozenRaw = JSON.parse(readFileSync(options.freezePath, "utf8"));
	const frozen = verifyFreeze(
		options.freezePath,
		frozenRaw.sessions[0],
		options.budgetPath,
	);
	const specs = z
		.record(
			z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
			z.object({
				provider: z.enum(["openai", "anthropic"]),
				model: z.string().min(1),
				phase: z.enum(["compose", "judge"]),
				requestCount: z.number().int().positive(),
				source: z.string().optional(),
				qualified: z.boolean().optional(),
			}),
		)
		.parse(frozen.protocol.apiSessions);
	const sessions = Object.keys(specs);
	if (
		canonicalJson([...sessions].sort()) !==
			canonicalJson([...frozen.sessions].sort()) ||
		!Object.values(specs).some((s) => s.phase === "compose") ||
		Object.values(specs).some(
			(s) =>
				s.phase === "judge" &&
				(!s.source || specs[s.source]?.phase !== "compose"),
		)
	)
		throw new Error("inconsistent frozen API sessions");
	const judgeConfig = frozen.protocol.judge as
		{ nativeSchema?: boolean; mode?: string } | undefined;
	if (judgeConfig?.mode && judgeConfig.mode !== "plan")
		throw new Error("quality report requires plan judgements");
	const policy = JSON.parse(readFileSync(options.budgetPath, "utf8"));
	const work = openWorkDb(options.dbPath ?? DEFAULT_WORK_DB);
	const catalog = loadBenchCatalog();
	const reportRun = work.startRun({
		kind: "quality-report",
		config: { freeze: frozen.digest },
		inputs: { freeze: frozen },
	});
	let completed = false;
	try {
		const generations = [];
		for (const [session, spec] of Object.entries(specs)) {
			if (spec.phase !== "compose") continue;
			const row = work.db
				.query<{ run_id: string }, [string]>(
					"SELECT run_id FROM runs WHERE kind='format' AND json_extract(config_json,'$.session')=? AND status='completed' ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.get(session);
			if (!row) throw new Error(`missing scored run: ${session}`);
			const exp = buildRunExport({
				runId: row.run_id,
				dbPath: options.dbPath ?? DEFAULT_WORK_DB,
				runsRoot: options.runsRoot,
			});
			if (exp.provenance.caseSetSha256 !== frozen.caseSetSha256)
				throw new Error("report case set differs from freeze");
			if (exp.config.freezeDigest !== frozen.digest)
				throw new Error("scored run was not bound to the frozen protocol");
			if (
				(exp.inputs.source as { sha256?: string } | undefined)?.sha256 !==
				frozen.sourceSha256
			)
				throw new Error("report scorer differs from freeze");
			const pinnedCases = new Map(
				readCaseSnapshot(exp.inputs.caseSnapshot).cases.map((c) => [c.id, c]),
			);
			const generationRecords = RecordedInference.fromDirectory(
				join(options.runsRoot ?? "data/runs/format", session, "recordings"),
			);
			const judgers = Object.entries(specs)
				.filter(([, s]) => s.phase === "judge" && s.source === session)
				.map(([id, s]) => ({
					id,
					spec: s,
					records: RecordedInference.fromDirectory(
						join(
							options.runsRoot ?? "data/runs/format",
							id,
							"judge-recordings",
						),
					),
				}));
			const cells = exp.cells.map((cell) => {
				const chosen =
					cell.definition?.steps.flatMap((step) => {
						const resolved = catalog.view.resolve(step.bundle, step.entry);
						return resolved.ok ? [resolved.record] : [];
					}) ?? [];
				const file = `${cell.caseId}--${cell.format}.json`;
				const votes = judgers.map((j) => {
					const raw = j.records.files.get(file);
					let judgement: Judgement | null = null;
					let error: string | null = null;
					try {
						if (!raw || !j.records.provenance.has(file))
							throw new Error("missing API judgement provenance");
						const candidate = generationRecords.files.get(file),
							c = pinnedCases.get(cell.caseId);
						if (
							!candidate ||
							!c ||
							cell.status !== "scored" ||
							sha256(candidate.output) !== cell.outputDigest
						)
							throw new Error("missing or changed scored candidate");
						const request = buildRecordedJudgeRequest({
							request: c.request,
							providedMaterials: c.providedMaterials,
							cards: catalog.cards,
							catalog: catalog.view,
							output: candidate.output,
							nativeSchema: judgeConfig?.nativeSchema === true,
							hostReading:
								(exp.config.condition as { promptStyle?: string } | undefined)
									?.promptStyle === "eumenes-p0-3",
						});
						if (inferenceDigest(request) !== raw.promptDigest)
							throw new Error("judgement does not target the scored candidate");
						judgement = parseJudgement(raw.output);
					} catch (e) {
						error = e instanceof Error ? e.message : "invalid judgement";
					}
					return {
						session: j.id,
						model: j.spec.model,
						qualifiedOnCalibration: j.spec.qualified ?? false,
						judgement,
						error,
					};
				});
				return {
					chosenEntries: chosen.map((r) => r.card.entry),
					contractTier:
						chosen.length === 0
							? "no-plan"
							: chosen.some(
										(r) =>
											r.card.output.origin === "fixture" ||
											r.execution === "unbound",
								  )
								? "fixture"
								: chosen.some((r) => r.support === "partial")
									? "partial"
									: "ready",
					caseId: cell.caseId,
					fixtureDependent: exp.cases.find((c) => c.id === cell.caseId)
						?.usesFixtureContracts,
					status: cell.status,
					referencePassed: cell.passed,
					mechanicallyValid:
						cell.authoringOk === true &&
						cell.score?.parseOk === true &&
						cell.score?.checkOk !== false,
					score: cell.score,
					votes,
					allJudgesAppropriate:
						votes.length > 0 &&
						votes.every((v) => v.judgement?.verdict === "appropriate"),
					qualifiedJudgeAppropriate:
						votes.some((v) => v.qualifiedOnCalibration) &&
						votes
							.filter((v) => v.qualifiedOnCalibration)
							.every((v) => v.judgement?.verdict === "appropriate"),
					judgeDisagreement:
						new Set(votes.map((v) => v.judgement?.verdict ?? "invalid")).size >
						1,
				};
			});
			generations.push({
				session,
				model: spec.model,
				scoredRunId: row.run_id,
				cells,
				totals: {
					count: cells.length,
					mechanicallyValid: cells.filter((c) => c.mechanicallyValid).length,
					mechanicalAndQualifiedSemantic: cells.filter(
						(c) => c.mechanicallyValid && c.qualifiedJudgeAppropriate,
					).length,
					referencePassed: cells.filter((c) => c.referencePassed).length,
					qualifiedJudgeAppropriate: cells.filter(
						(c) => c.qualifiedJudgeAppropriate,
					).length,
					qualifiedAndReference: cells.filter(
						(c) => c.referencePassed && c.qualifiedJudgeAppropriate,
					).length,
					allJudgesAppropriate: cells.filter((c) => c.allJudgesAppropriate)
						.length,
					disagreements: cells.filter((c) => c.judgeDisagreement).length,
				},
			});
		}
		const countedCalls = new Set<string>();
		const calls = sessions.map((session) => {
			const spec = specs[session]!;
			const records = RecordedInference.fromDirectory(
				join(
					options.runsRoot ?? "data/runs/format",
					session,
					spec.phase === "compose" ? "recordings" : "judge-recordings",
				),
			);
			const sources = [...records.provenance.values()];
			for (const [file, source] of records.provenance) {
				const identity = `${source.runId}/${source.trialId}`;
				if (countedCalls.has(identity))
					throw new Error("API call reused as an independent request");
				countedCalls.add(identity);
				const recording = records.files.get(file)!;
				verifyApiRecording({
					db: work.db,
					runsRoot: options.runsRoot ?? "data/runs/format",
					file,
					source,
					recording,
					provider: spec.provider,
					model: spec.model,
					phase: spec.phase,
				});
			}
			const times = sources.map((s) => s.durationMs).sort((a, b) => a - b);
			const sum = (key: keyof (typeof sources)[number]["usage"]) =>
				sources.length > 0 && sources.every((s) => s.usage[key] !== null)
					? sources.reduce((n, s) => n + s.usage[key]!, 0)
					: null;
			return {
				session,
				provider: spec.provider,
				model: spec.model,
				phase: spec.phase,
				expected: spec.requestCount,
				successfulHttpRequests: sources.length,
				complete: sources.length === spec.requestCount,
				generationLatencyMs: {
					median: times[Math.floor(times.length / 2)] ?? null,
					p95: times[Math.ceil(times.length * 0.95) - 1] ?? null,
				},
				providerUsage: {
					inputTokens: sum("inputTokens"),
					outputTokens: sum("outputTokens"),
					cachedTokens: sum("cachedTokens"),
					reasoningTokens: sum("reasoningTokens"),
					calls: sum("calls"),
				},
				actualBilledUsd: null,
			};
		});
		const result = {
			catalogCoverage: {
				enabledDenominator: catalog.records.filter((r) => r.enabled).length,
				offered: catalog.cards.length,
				chosenEntries: [
					...new Set(
						generations.flatMap((g) => g.cells.flatMap((c) => c.chosenEntries)),
					),
				].sort(),
			},
			version: 2,
			reportRun,
			freezeDigest: frozen.digest,
			sourceSha256: frozen.sourceSha256,
			protocol: frozen.protocol,
			budget: apiBudget(work.db, policy.id, policy.ceilingUsd).status(),
			calls,
			generations,
			limitations: [
				"Synthetic authoring tasks and mock execution; no real tool or host acceptance",
				"One sample per task; no repeatability estimate",
				"Luna judge was not qualified by calibration; votes remain diagnostic",
				"Author-AI reference labels; human calibration is separately recorded when available",
				"No API billing result is available",
			],
		};
		writeFileSync(options.out, JSON.stringify(result, null, 2) + "\n", {
			flag: "wx",
		});
		const trial = work.startTrial({
			runId: reportRun,
			caseId: frozen.id,
			condition: "report",
			attempt: 1,
			phase: "aggregate",
		});
		work.finishTrial(trial, {
			status: "completed",
			outputText: canonicalJson(result),
		});
		completed =
			calls.every((c) => c.complete) &&
			generations.every(
				(g) =>
					g.cells.length === specs[g.session]!.requestCount &&
					g.cells.every(
						(c) =>
							c.status === "scored" &&
							c.votes.length > 0 &&
							c.votes.every((v) => v.error === null),
					),
			);
		return {
			reportRun,
			completed,
			budget: result.budget,
			generations: generations.map((g) => ({
				session: g.session,
				model: g.model,
				...g.totals,
			})),
		};
	} finally {
		work.finishRun(reportRun, completed ? "completed" : "failed");
		work.close();
		catalog.close();
	}
}
