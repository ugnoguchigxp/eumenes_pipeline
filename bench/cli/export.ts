/**
 * bench:export — write one work-db run as a verifiable export (plan §10 P3).
 *
 *   bun run bench:export -- --run <runId> [--db <path>] [--out <dir>] [--cases <dir>]
 *
 * Writes `<out>/<runId>.json` (the full export) and `<out>/<runId>.md` (a compact
 * rendering). Totals in the export are recomputed from the work db and cross-checked
 * against the session's summary.json when that summary belongs to the run; a real
 * mismatch (same run, different numbers) exits 1. A summary left by a later re-run of
 * the session is reported as superseded, not as a failure. Read-only: the guard is
 * installed with no allowances, like the other offline bench commands.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	buildRunExport,
	DEFAULT_EXPORTS_DIR,
	renderExportMarkdown,
} from "../export/export.ts";
import { installGuard } from "../mock/guard.ts";

installGuard();
const { values } = parseArgs({
	options: {
		run: { type: "string" },
		db: { type: "string" },
		out: { type: "string" },
		cases: { type: "string" },
	},
});
if (!values.run) {
	console.error("bench:export: --run <runId> is required");
	process.exit(2);
}
const exp = buildRunExport({
	runId: values.run,
	...(values.db ? { dbPath: values.db } : {}),
	...(values.cases ? { casesDir: values.cases } : {}),
});
const outDir = values.out ?? DEFAULT_EXPORTS_DIR;
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, `${exp.run.runId}.json`);
const mdPath = join(outDir, `${exp.run.runId}.md`);
writeFileSync(jsonPath, `${JSON.stringify(exp, null, "\t")}\n`);
writeFileSync(mdPath, renderExportMarkdown(exp));
const cross = exp.summaryCrossCheck;
console.log(
	`exported run ${exp.run.runId} (session ${cross.session ?? "n/a"}, condition ${exp.condition?.id ?? "n/a"}): ` +
		`cells ${exp.totals.cells}, passed ${exp.totals.passed}/${exp.totals.scored}` +
		`${exp.repair ? `; repair passed ${exp.repair.passedBefore} -> ${exp.repair.passedAfter} over ${exp.repair.attempted}` : ""}`,
);
console.log(`wrote ${jsonPath} and ${mdPath}`);
if (!cross.summaryFound) {
	console.log("cross-check: no session summary found; totals are db-only");
} else if (!cross.runMatches) {
	console.log(
		`cross-check: session summary belongs to run ${cross.summaryRunId}; superseded, not compared`,
	);
} else {
	console.log(
		`cross-check: totals ${cross.totalsEqual ? "equal" : "DIFFER"}, cells ${cross.cellsEqual ? "equal" : "DIFFER"}, repair ${cross.repairEqual ? "equal" : "DIFFER"}`,
	);
	for (const d of cross.differences) console.log(`  difference: ${d}`);
}
const mismatch =
	cross.runMatches &&
	(cross.totalsEqual === false ||
		cross.cellsEqual === false ||
		cross.repairEqual === false);
process.exit(mismatch ? 1 : 0);
