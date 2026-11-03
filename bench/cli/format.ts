/**
 * bench:format — replay recorded (agent-model) outputs through parse → check → mock → score
 * under one prompt condition, split by format and fixture dependence.
 *
 *   bun run bench:format -- --session <name> [--case id,id] [--format json,md-yaml]
 *     [--condition baseline|compact|oneshot] [--candidates <file.json>] [--db <path>]
 *
 * The session names `data/runs/format/<name>/`: request files for cells without recordings
 * are written there, recordings are read from there. Exits 1 while any cell is missing,
 * digest-mismatched or in inference error, so a half-prepared session cannot look complete.
 * `--candidates` takes a JSON file `{ [caseId]: entryId[] }` of per-case offered subsets;
 * the run then records its condition as `subset:<digest of the file, first 8 hex>`.
 * No model is called and nothing is reached: the guard's only allowance is the local
 * tokenizer counter (`bench/tokens.ts`), a process that reads one local file and stdin.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	BASELINE_CONDITION,
	resolveCondition,
	subsetConditionId,
	type FormatCondition,
} from "../format/conditions.ts";
import type { FormatId } from "../formats/index.ts";
import { FORMAT_IDS } from "../formats/index.ts";
import { runFormat, type FormatGroupSummary } from "../format/run.ts";
import { installGuard } from "../mock/guard.ts";
import { isTokenizerCommand } from "../tokens.ts";

installGuard({ allowProcess: (command) => isTokenizerCommand(command) });
const { values } = parseArgs({
	options: {
		session: { type: "string" },
		case: { type: "string" },
		format: { type: "string" },
		condition: { type: "string" },
		candidates: { type: "string" },
		db: { type: "string" },
	},
});
if (!values.session) {
	console.error("bench:format: --session <name> is required");
	process.exit(2);
}
let condition: FormatCondition = values.condition
	? resolveCondition(values.condition)
	: BASELINE_CONDITION;
let candidates: Record<string, readonly string[]> | undefined;
if (values.candidates) {
	const raw = readFileSync(values.candidates);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch {
		console.error(
			`bench:format: --candidates ${values.candidates} is not JSON`,
		);
		process.exit(2);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!Object.values(parsed).every(
			(v) => Array.isArray(v) && v.every((e) => typeof e === "string"),
		)
	) {
		console.error(
			"bench:format: --candidates must be a JSON object { [caseId]: entryId[] }",
		);
		process.exit(2);
	}
	candidates = parsed as Record<string, readonly string[]>;
	const digest = createHash("sha256").update(raw).digest("hex");
	condition = { ...condition, id: subsetConditionId(digest) };
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
	condition,
	...(candidates ? { candidates } : {}),
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
const sumTokens = (values: (number | null)[]) => {
	if (!report.tokenizer.available) return "n/a (tokenizer unavailable)";
	const counted = values.filter((v) => v !== null);
	return `${counted.reduce((a, v) => a + (v ?? 0), 0)} (${counted.length}/${values.length} cells counted)`;
};
console.log(
	`condition ${report.condition.id} (cardSet ${report.condition.cardSet}, style ${report.condition.cardStyle}, shots ${report.condition.shots}); ` +
		`tokenizer ${report.tokenizer.available ? `${report.tokenizer.repo ?? "unknown"}@${report.tokenizer.revision ?? "?"}` : "unavailable"}; ` +
		`prompt tokens ${sumTokens(report.cells.map((c) => c.promptTokens))}, output tokens ${sumTokens(report.cells.map((c) => c.outputTokens))}`,
);
console.log(
	`run ${report.runId}; session ${report.sessionDir} (summary.json written there)`,
);
const incomplete =
	report.totals.missing +
	report.totals.digestMismatch +
	report.totals.inferenceErrors;
process.exit(incomplete > 0 ? 1 : 0);
