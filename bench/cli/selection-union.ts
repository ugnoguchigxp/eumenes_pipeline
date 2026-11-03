/**
 * bench:selection-union — accuracy item 3: does presenting
 * emb-prefix top-12 ∪ BM25 top-k recover the required entries the frozen
 * emb-prefix presentation misses, and at what presentation growth?
 *
 *   bun run bench:selection-union --results <recorded results.json> [--db <path>] [--out <dir>]
 *
 * Fully offline: the emb-prefix rankings are read from the recorded results
 * file and the BM25 leg is recomputed locally (see selection/union.ts). No
 * embedding Provider is contacted. Output lands in
 * `<out>/<runId>/results.json` (default `data/runs/selection-union/`) and the
 * run is recorded in the work DB.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderUnionSummary, runUnionAnalysis } from "../selection/union.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";

const { values } = parseArgs({
	options: {
		db: { type: "string" },
		out: { type: "string", default: "data/runs/selection-union" },
		results: { type: "string" },
	},
});
if (!values.results) {
	console.error(
		"bench:selection-union: --results <recorded selection results.json> is required",
	);
	process.exit(2);
}

const report = runUnionAnalysis({ recordedResultsPath: values.results });

const outDir = join(values.out, report.runId);
mkdirSync(outDir, { recursive: true });
writeFileSync(
	join(outDir, "results.json"),
	JSON.stringify(report, null, 2) + "\n",
);
writeFileSync(join(outDir, "summary.md"), renderUnionSummary(report));

// Record the run in the work DB (AGENTS.md: every run is a work-db run).
const work = openWorkDb(values.db ?? DEFAULT_WORK_DB);
try {
	const runId = work.startRun({
		kind: "selection",
		config: {
			experiment: "accuracy3-union-presentation",
			experimentRunId: report.runId,
			sourceRunId: report.sourceRunId,
			split: report.split,
			bm25Validation: report.bm25Validation,
		},
		inputs: {
			snapshotSha256: report.catalog.snapshotSha256,
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
				condition: "selection-union",
				attempt: 1,
				phase: "select",
			});
			work.finishTrial(trialId, {
				status: "completed",
				outputText: JSON.stringify(caseResult),
			});
		}
	} catch (error) {
		recorded = false;
		throw error;
	} finally {
		work.finishRun(runId, recorded ? "completed" : "failed");
	}
} finally {
	work.close();
}

console.log(renderUnionSummary(report));
console.log(`results: ${join(outDir, "results.json")}`);
