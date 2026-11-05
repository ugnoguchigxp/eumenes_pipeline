/**
 * bench:selection-tuning — the P4 parameter search over the Wave B retrieval
 * methods (RRF k, weighted score fusion, prefix on/off), plus the one-shot
 * holdout evaluation of the frozen configuration.
 *
 *   bun run bench:selection-tuning -- --split dev|holdout
 *     [--configs id,id] [--db <path>] [--out <dir>]
 *
 * Dev runs evaluate every configuration (default) and apply the declared
 * freeze rule. Holdout runs must name the frozen configuration (and normally
 * the `emb` control) via --configs: the split is evaluated once, as recorded,
 * and never used to re-tune. The embedding transport is the live one
 * (`PIPELINE_EMBED_URL` / `PIPELINE_EMBED_NETWORK`); with no configuration
 * nothing is connected and the run is reported as not measured. The reach
 * guard allows fetch to exactly that endpoint — nothing else (no reranker
 * here: the public Ruri rerank was already rejected in Wave B, and the user's
 * production reranker Provider is never touched).
 *
 * Results land in `<out>/<runId>/` (results.json + summary.md, default
 * `data/runs/selection-tuning/`, outside git) and the run is also recorded in
 * the work DB.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { installGuard } from "../mock/guard.ts";
import { HttpEmbedTransport, liveConfigStatus } from "../selection/live.ts";
import {
	renderTuningSummary,
	runSelectionTuning,
	TUNING_CONFIG_IDS,
	tuningCaseRecordJson,
	type TuningConfigId,
} from "../selection/tuning.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";

const { values } = parseArgs({
	options: {
		split: { type: "string", default: "dev" },
		configs: { type: "string" },
		db: { type: "string" },
		out: { type: "string", default: "data/runs/selection-tuning" },
	},
});
if (values.split !== "dev" && values.split !== "holdout") {
	console.error(
		`bench:selection-tuning: unknown --split "${values.split}" (dev | holdout)`,
	);
	process.exit(2);
}
let configIds: TuningConfigId[] | undefined;
if (values.configs) {
	const requested = values.configs.split(",");
	const unknown = requested.filter(
		(id) => !(TUNING_CONFIG_IDS as readonly string[]).includes(id),
	);
	if (unknown.length > 0) {
		console.error(
			`bench:selection-tuning: unknown config id(s): ${unknown.join(", ")} (expected one of ${TUNING_CONFIG_IDS.join(", ")})`,
		);
		process.exit(2);
	}
	configIds = requested as TuningConfigId[];
}
if (values.split === "holdout" && !configIds) {
	console.error(
		"bench:selection-tuning: --split holdout requires --configs naming the frozen configuration (and the emb control); the holdout split is never swept",
	);
	process.exit(2);
}

const status = liveConfigStatus();
if (status.kind === "missing") {
	console.log(
		`bench:selection-tuning: 埋め込み Provider が未設定です（不足: ${status.missing.join(", ")}）。接続せず、未測定として残します。`,
	);
	process.exit(0);
}

installGuard({ allowFetch: (url) => url === status.config.url });

const transport = new HttpEmbedTransport(status.config);
const report = await runSelectionTuning({
	transport,
	split: values.split,
	...(configIds ? { configIds } : {}),
});

// Record the run in the work DB (AGENTS.md: every run is a work-db run).
const work = openWorkDb(values.db ?? DEFAULT_WORK_DB);
try {
	const runId = work.startRun({
		kind: "selection",
		config: {
			experiment: "p4-selection-tuning",
			experimentRunId: report.runId,
			split: report.split,
			configs: report.configs,
			frozenByRule: report.frozenByRule,
			network: report.embedding.network,
		},
		inputs: {
			caseSnapshot: report.caseSnapshot,
			snapshotSha256: report.catalog.snapshotSha256,
			contractsSha256: report.catalog.contractsSha256,
			fixturesSha256: report.catalog.fixturesSha256,
			catalogVersion: report.catalog.version,
			caseIds: report.perCase.map((c) => c.caseId),
		},
	});
	let recorded = true;
	try {
		for (const caseResult of report.perCase) {
			const trialId = work.startTrial({
				runId,
				caseId: caseResult.caseId,
				condition: "selection-tuning",
				attempt: 1,
				phase: "select",
			});
			work.finishTrial(trialId, {
				status: "completed",
				outputText: tuningCaseRecordJson(caseResult),
			});
		}
	} catch (error) {
		recorded = false;
		throw error;
	} finally {
		work.finishRun(runId, recorded ? "completed" : "failed");
	}
	console.log(`work db run ${runId}`);
} finally {
	work.close();
}

const outDir = join(values.out, report.runId);
mkdirSync(outDir, { recursive: true });
writeFileSync(
	join(outDir, "results.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(join(outDir, "summary.md"), renderTuningSummary(report));
console.log(`results: ${join(outDir, "results.json")}`);
console.log(renderTuningSummary(report));
