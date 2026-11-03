/**
 * bench:format — replay recorded (agent-model) outputs through parse → check → mock → score
 * under the fixed prompt condition, split by format and fixture dependence.
 *
 *   bun run bench:format -- --session <name> [--case id,id] [--format json,md-yaml] [--db <path>]
 *
 * The session names `data/runs/format/<name>/`: request files for cells without recordings
 * are written there, recordings are read from there. Exits 1 while any cell is missing,
 * digest-mismatched or in inference error, so a half-prepared session cannot look complete.
 * No model is called and nothing is reached: the guard is installed with no allowances.
 */
import { parseArgs } from "node:util";
import type { FormatId } from "../formats/index.ts";
import { FORMAT_IDS } from "../formats/index.ts";
import { runFormat, type FormatGroupSummary } from "../format/run.ts";
import { installGuard } from "../mock/guard.ts";

installGuard();
const { values } = parseArgs({
	options: {
		session: { type: "string" },
		case: { type: "string" },
		format: { type: "string" },
		db: { type: "string" },
	},
});
if (!values.session) {
	console.error("bench:format: --session <name> is required");
	process.exit(2);
}
const formats = values.format
	? (values.format.split(",") as FormatId[])
	: undefined;
if (formats && formats.some((f) => !FORMAT_IDS.includes(f))) {
	console.error(
		`bench:format: unknown format (expected one of ${FORMAT_IDS.join(", ")})`,
	);
	process.exit(2);
}
const report = await runFormat({
	session: values.session,
	...(values.db ? { dbPath: values.db } : {}),
	...(values.case ? { caseIds: values.case.split(",") } : {}),
	...(formats ? { formats } : {}),
});

const line = (label: string, g: FormatGroupSummary) =>
	`${label}: cells ${g.cells} (scored ${g.scored}, missing ${g.missing}, digest-mismatch ${g.digestMismatch}, inference-error ${g.inferenceErrors})` +
	` | parse ${g.parseOk}/${g.scored}, authoring ${g.authoringOk}/${g.scored}` +
	` | check ${g.checkOk}/${g.checkAttempts}, state ${g.stateMatch}/${g.scored}, bundles ${g.bundlesOk}/${g.scored}` +
	` | mock ${g.mockCompleted}/${g.mockAttempts} | passed ${g.passed}/${g.scored}`;
for (const [format, groups] of Object.entries(report.byFormat)) {
	console.log(`[${format}]`);
	console.log(`  ${line("catalog-only    ", groups.catalogOnly)}`);
	console.log(`  ${line("fixture-dependent", groups.fixtureDependent)}`);
	console.log(`  ${line("total           ", groups.total)}`);
}
console.log(line("ALL", report.totals));
for (const cell of report.cells)
	if (cell.status !== "scored")
		console.log(`  ${cell.status}: ${cell.caseId} / ${cell.format}`);
console.log(
	`run ${report.runId}; session ${report.sessionDir} (summary.json written there)`,
);
const incomplete =
	report.totals.missing +
	report.totals.digestMismatch +
	report.totals.inferenceErrors;
process.exit(incomplete > 0 ? 1 : 0);
