/** Aggregate frozen API results without model calls. */
import { parseArgs } from "node:util";
import { runQualityReport } from "../export/quality-report.ts";
import { installGuard } from "../mock/guard.ts";
installGuard();
const { values } = parseArgs({
	options: {
		freeze: { type: "string" },
		budget: { type: "string" },
		out: { type: "string" },
		db: { type: "string" },
	},
});
if (!values.freeze || !values.budget || !values.out)
	throw new Error(
		"requires --freeze FILE --budget FILE --out NEW_FILE [--db FILE]",
	);
const result = runQualityReport({
	freezePath: values.freeze,
	budgetPath: values.budget,
	out: values.out,
	dbPath: values.db,
});
console.log(JSON.stringify(result));
if (!result.completed) process.exitCode = 1;
