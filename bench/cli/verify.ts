/**
 * bench:verify — offline wiring check. No model, no network, no process; exits 1 on any failure.
 *
 *   bun run bench:verify [--db data/work/bench.sqlite3 | --db :memory:]
 */
import { parseArgs } from "node:util";
import { installGuard } from "../mock/guard.ts";
import { runVerify } from "../verify.ts";

installGuard();
const { values } = parseArgs({ options: { db: { type: "string" } } });
const report = await runVerify(values.db ? { dbPath: values.db } : {});
const failed = report.checks.filter((c) => !c.ok);
for (const check of report.checks)
	console.log(`${check.ok ? "ok  " : "FAIL"} ${check.id}  ${check.detail}`);
console.log(
	`\n${report.checks.length - failed.length}/${report.checks.length} passed; run ${report.runId}; catalogVersion ${report.catalogVersion.slice(0, 12)}`,
);
process.exit(report.ok ? 0 : 1);
