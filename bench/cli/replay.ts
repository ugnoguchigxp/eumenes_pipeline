/** Run from a verified evidence directory after `bun install --frozen-lockfile --ignore-scripts`. */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { canonicalJson } from "../catalog/load.ts";
import {
	createEvidenceBundle,
	verifyEvidenceBundle,
} from "../export/bundle.ts";
import { buildRunExport } from "../export/export.ts";
import { runFormat } from "../format/run.ts";
import { installGuard } from "../mock/guard.ts";

installGuard();
const { values } = parseArgs({
	options: {
		bundle: { type: "string" },
		run: { type: "string" },
		db: { type: "string" },
		replay: { type: "boolean" },
	},
});
if (values.run && values.bundle && values.db) {
	console.log(
		JSON.stringify(
			createEvidenceBundle({
				runId: values.run,
				dbPath: values.db,
				target: values.bundle,
			}),
		),
	);
} else if (values.replay) {
	verifyEvidenceBundle(".");
	const meta = JSON.parse(readFileSync("replay.json", "utf8"));
	const old = buildRunExport({
		runId: meta.runId,
		dbPath: "data/replay-source.sqlite3",
	});
	const config = meta.config;
	const report = await runFormat({
		session: config.session,
		dbPath: "data/replay-result.sqlite3",
		casesDir: "data/replay-cases",
		caseIds: meta.caseIds,
		formats: config.formats,
		seed: config.seed,
		condition: config.conditionDefinition ?? config.condition,
		candidates: meta.inputs?.candidates,
		repair: config.repair,
		restoreSyntax: config.restoreSyntax,
		normalizeIds: config.normalizeIds,
		triage: config.triage,
		staged: config.staged,
		coverageRepair: config.coverageRepair,
	});
	const now = buildRunExport({
		runId: report.runId,
		dbPath: "data/replay-result.sqlite3",
	});
	const project = (e: typeof old) =>
		e.cells.map((c) => ({
			caseId: c.caseId,
			format: c.format,
			status: c.status,
			passed: c.passed,
			score: c.score,
			criteria: c.criteria,
			definition: c.definition,
			repair: c.repair
				? { status: c.repair.status, after: c.repair.after }
				: null,
		}));
	const equal = canonicalJson(project(old)) === canonicalJson(project(now));
	writeFileSync(
		"data/replay-comparison.json",
		JSON.stringify(
			{
				equal,
				sourceRun: old.run.runId,
				replayRun: now.run.runId,
				cells: now.cells.length,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ equal, cells: now.cells.length, apiCalls: 0 }));
	if (!equal) process.exitCode = 1;
} else if (values.bundle) {
	const result = verifyEvidenceBundle(values.bundle);
	console.log(
		JSON.stringify({
			verified: true,
			runId: result.runId,
			files: Object.keys(result.files).length,
		}),
	);
} else
	throw new Error(
		"use --run ID --db PATH --bundle NEW_DIR, --bundle DIR, or --replay inside a bundle",
	);
