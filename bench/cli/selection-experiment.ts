/**
 * bench:selection-exp — the Wave B selection experiment: five retrieval methods
 * (embedding, embedding with e5 prefixes, BM25, RRF fusion, embedding + public Ruri
 * reranker) rank the offered cards for the dev-split pipeline cases.
 *
 *   bun run bench:selection-exp [--db <path>] [--out <dir>] [--rerank on|off]
 *
 * The embedding transport is the live one (`PIPELINE_EMBED_URL` /
 * `PIPELINE_EMBED_NETWORK`); with no configuration nothing is connected and the
 * experiment is reported as not measured. The reach guard allows fetch to exactly
 * that endpoint and a process spawn of exactly the reranker helper command —
 * nothing else. Results land in `<out>/<runId>/` (results.json + summary.md,
 * default `data/runs/selection-exp/`, outside git) and the run is also recorded
 * in the work DB.
 *
 * The reranker is the PUBLIC cl-nagoya/ruri-reranker-small snapshot kept under
 * ~/workspace/tools/ — never the user's retrained production reranker, whose
 * Provider is not touched (plan §9; AGENTS.md).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { installGuard } from "../mock/guard.ts";
import {
	caseRecordJson,
	renderSelectionSummary,
	runSelectionExperiment,
} from "../selection/experiment.ts";
import { HttpEmbedTransport, liveConfigStatus } from "../selection/live.ts";
import {
	isRerankCommand,
	rerankProvenance,
	scoreRerankPairs,
} from "../selection/rerank.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";

const { values } = parseArgs({
	options: {
		db: { type: "string" },
		out: { type: "string", default: "data/runs/selection-exp" },
		rerank: { type: "string", default: "on" },
	},
});
if (values.rerank !== "on" && values.rerank !== "off") {
	console.error(
		`bench:selection-exp: unknown --rerank "${values.rerank}" (on | off)`,
	);
	process.exit(2);
}

const status = liveConfigStatus();
if (status.kind === "missing") {
	console.log(
		`bench:selection-exp: 埋め込み Provider が未設定です（不足: ${status.missing.join(", ")}）。接続せず、未測定として残します。`,
	);
	process.exit(0);
}

installGuard({
	allowFetch: (url) => url === status.config.url,
	allowProcess: (command) => isRerankCommand(command),
});

const transport = new HttpEmbedTransport(status.config);
const provenance = rerankProvenance();
const report = await runSelectionExperiment({
	transport,
	rerankScorer:
		values.rerank === "on" ? async (pairs) => scoreRerankPairs(pairs) : null,
	rerankProvenance: provenance,
});

// Record the run in the work DB (AGENTS.md: every run is a work-db run).
const work = openWorkDb(values.db ?? DEFAULT_WORK_DB);
try {
	const runId = work.startRun({
		kind: "selection",
		config: {
			experiment: "wave-b-selection",
			experimentRunId: report.runId,
			methods: Object.keys(report.methods),
			unavailableMethods: report.unavailableMethods,
			network: report.embedding.network,
			reranker: {
				model: report.reranker.model,
				revision: report.reranker.revision,
				status: report.reranker.status,
			},
		},
		inputs: {
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
				condition: "selection-experiment",
				attempt: 1,
				phase: "select",
			});
			work.finishTrial(trialId, {
				status: "completed",
				outputText: caseRecordJson(caseResult),
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
writeFileSync(join(outDir, "summary.md"), renderSelectionSummary(report));
console.log(`results: ${join(outDir, "results.json")}`);
console.log(renderSelectionSummary(report));
