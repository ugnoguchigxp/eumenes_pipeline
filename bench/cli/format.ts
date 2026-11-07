/**
 * bench:format — replay recorded (agent-model) outputs through parse → check → mock → score
 * under one prompt condition, split by format and fixture dependence.
 *
 *   bun run bench:format -- --session <name> [--case id,id] [--format json,md-yaml]
 *     [--condition baseline|compact|oneshot|minjson|threshold] [--candidates <file.json>]
 *     [--repair] [--restore-syntax] [--normalize-ids] [--triage] [--db <path>]
 *
 * The session names `data/runs/format/<name>/`: request files for cells without recordings
 * are written there, recordings are read from there. Exits 1 while any cell is missing,
 * digest-mismatched or in inference error, so a half-prepared session cannot look complete.
 * `--repair` adds one repair round for mechanically failed cells (parse / authoring /
 * check errors): repair requests land in `<session>/repair-requests/`, repair recordings
 * are read from `<session>/repair-recordings/`, and the exit code also covers them.
 * `--restore-syntax` adds one deterministic syntax-restore stage in front of the strict
 * parser (`json` format only): an output the strict parser rejects is restored once and
 * re-parsed strictly; recordings are never rewritten, and the summary records per cell
 * whether restore recovered the parse.
 * `--normalize-ids` adds one deterministic step-id normalization stage at the authoring
 * gate: a definition that fails the `AuthoringOutcome` contract ONLY on step-id shape
 * has its offending ids (and their references) rewritten to the contract pattern and
 * is re-validated; a collision refuses the rewrite. Recordings are never rewritten,
 * and the summary records per cell whether normalization recovered the gate.
 * `--triage` adds one recorded pre-pass per case that judges only whether the
 * request's information is sufficient; the conclusion is appended to the composing
 * prompt. Triage requests land in `<session>/triage-requests/`, triage recordings
 * are read from `<session>/triage-recordings/`, and a case without a usable
 * conclusion blocks its composing cells (reported missing, like a missing
 * composing recording).
 * `--staged` adds the staged generation: one recorded enumeration pre-pass per
 * case (stage A) whose item list and marker convention the composing prompt
 * carries, with deterministic item coverage computed per cell. Enumeration
 * requests land in `<session>/enum-requests/`, recordings in
 * `<session>/enum-recordings/`, and a case without a usable item list blocks
 * its composing cells the same way. `--coverage-repair` (requires `--staged`)
 * adds stage C: one repair round for mechanically sound cells that leave
 * enumerated items uncovered, fed the uncovered items as machine errors.
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
		cases: { type: "string" },
		freeze: { type: "string" },
		format: { type: "string" },
		condition: { type: "string" },
		"host-prompt": { type: "string" },
		"host-toolchain-revision": { type: "string" },
		candidates: { type: "string" },
		repair: { type: "boolean" },
		"restore-syntax": { type: "boolean" },
		"normalize-ids": { type: "boolean" },
		triage: { type: "boolean" },
		staged: { type: "boolean" },
		"coverage-repair": { type: "boolean" },
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
	...(values.freeze ? { freezePath: values.freeze } : {}),
	condition,
	hostPromptPath: values["host-prompt"],
	hostToolchainRevisionId: values["host-toolchain-revision"],
	...(values.repair ? { repair: true } : {}),
	...(values["restore-syntax"] ? { restoreSyntax: true } : {}),
	...(values["normalize-ids"] ? { normalizeIds: true } : {}),
	...(values.triage ? { triage: true } : {}),
	...(values.staged ? { staged: true } : {}),
	...(values["coverage-repair"] ? { coverageRepair: true } : {}),
	...(candidates ? { candidates } : {}),
	...(values.db ? { dbPath: values.db } : {}),
	...(values.cases ? { casesDir: values.cases } : {}),
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
if (report.repair) {
	const r = report.repair;
	console.log(
		`repair: attempted ${r.attempted} (scored ${r.scored}, missing ${r.missing}, digest-mismatch ${r.digestMismatch}, inference-error ${r.inferenceErrors})` +
			` | passed ${r.passedBefore} -> ${r.passedAfter} over attempted cells` +
			` | repair prompt tokens ${r.promptTokens ?? "n/a"}, output tokens ${r.outputTokens ?? "n/a"}`,
	);
	for (const cell of report.cells)
		if (cell.repair && cell.repair.status !== "scored")
			console.log(
				`  repair ${cell.repair.status}: ${cell.caseId} / ${cell.format}`,
			);
}
if (report.restore) {
	console.log(
		`syntax restore: attempted ${report.restore.attempted}, recovered ${report.restore.recovered} (composing cells; raw recordings unchanged)`,
	);
	for (const cell of report.cells)
		if (cell.syntaxRestored)
			console.log(`  restored: ${cell.caseId} / ${cell.format}`);
}
if (report.normalize) {
	console.log(
		`id normalization: attempted ${report.normalize.attempted}, recovered ${report.normalize.recovered} (composing cells; raw recordings unchanged)`,
	);
	for (const cell of report.cells)
		if (cell.idsNormalized)
			console.log(`  normalized: ${cell.caseId} / ${cell.format}`);
}
if (report.triage) {
	const t = report.triage;
	console.log(
		`triage: cases ${t.cases} (concluded ${t.concluded}: proceed ${t.proceed}, needs_input ${t.needsInput}; missing ${t.missing}, digest-mismatch ${t.digestMismatch}, invalid ${t.invalid})` +
			` | triage prompt tokens ${t.promptTokens ?? "n/a"}, output tokens ${t.outputTokens ?? "n/a"}`,
	);
}
if (report.staged) {
	const s = report.staged;
	console.log(
		`staged enumeration: cases ${s.cases} (concluded ${s.concluded}; missing ${s.missing}, digest-mismatch ${s.digestMismatch}, invalid ${s.invalid}); items ${s.items}` +
			` | enum prompt tokens ${s.promptTokens ?? "n/a"}, output tokens ${s.outputTokens ?? "n/a"}`,
	);
	for (const cell of report.cells)
		if (cell.coverage && cell.coverage.uncovered.length > 0)
			console.log(
				`  coverage ${cell.caseId} / ${cell.format}: ${cell.coverage.covered}/${cell.coverage.total} (uncovered: ${cell.coverage.uncovered.join(", ")})`,
			);
}
const sumTokens = (values: (number | null)[]) => {
	if (!report.tokenizer.available) return "n/a (tokenizer unavailable)";
	const counted = values.filter((v) => v !== null);
	return `${counted.reduce((a, v) => a + (v ?? 0), 0)} (${counted.length}/${values.length} cells counted)`;
};
console.log(
	`condition ${report.condition.id} (cardSet ${report.condition.cardSet}, style ${report.condition.cardStyle}, shots ${report.condition.shots}, output ${report.condition.outputStyle}); ` +
		`tokenizer ${report.tokenizer.available ? `${report.tokenizer.repo ?? "unknown"}@${report.tokenizer.revision ?? "?"}` : "unavailable"}; ` +
		`prompt tokens ${sumTokens(report.cells.map((c) => c.promptTokens))}, output tokens ${sumTokens(report.cells.map((c) => c.outputTokens))}`,
);
console.log(
	`run ${report.runId}; session ${report.sessionDir} (summary.json written there)`,
);
const incomplete =
	report.totals.missing +
	report.totals.digestMismatch +
	report.totals.inferenceErrors +
	(report.repair
		? report.repair.missing +
			report.repair.digestMismatch +
			report.repair.inferenceErrors
		: 0);
process.exit(incomplete > 0 ? 1 : 0);
