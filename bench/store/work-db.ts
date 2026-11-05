/**
 * Work database for bench runs (plan §10 "P0で残す成果物と再現方法"): runs, trials, model usage,
 * mock calls, check findings and scores, joined by run / trial ids.
 *
 * Separate from the catalog snapshot, which stays read-only evidence. Append-only by construction:
 * triggers refuse deletes, and updates of a run or trial once it is no longer `running`. A changed
 * or resumed experiment is a new run linked by `parent_run_id`, never a rewrite of finished trials.
 * Gold labels are NOT stored here: cases and their expectations live in `data/cases/`, read by the
 * evaluator only.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Issue } from "../../src/check.ts";
import type { InferenceResult } from "../../src/ports.ts";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import { sourceProvenance } from "../cases/provenance.ts";
import type { MockCall } from "../mock/host.ts";
import { API_BUDGET_SCHEMA } from "./api-budget.ts";

export const DEFAULT_WORK_DB = "data/work/bench.sqlite3";
export const WORK_DB_VERSION = 2;

const SCHEMA_V1 = `
CREATE TABLE runs(
	run_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	parent_run_id TEXT REFERENCES runs(run_id),
	created_at TEXT NOT NULL,
	config_json TEXT NOT NULL,
	config_digest TEXT NOT NULL,
	inputs_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
	finished_at TEXT,
	note TEXT
);
CREATE TABLE trials(
	trial_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(run_id),
	case_id TEXT NOT NULL,
	condition TEXT NOT NULL,
	attempt INTEGER NOT NULL CHECK(attempt >= 1),
	phase TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
	started_at TEXT NOT NULL,
	finished_at TEXT,
	output_text TEXT,
	output_digest TEXT,
	error TEXT,
	UNIQUE(run_id, case_id, condition, attempt, phase)
);
CREATE TABLE model_calls(
	id INTEGER PRIMARY KEY,
	trial_id TEXT NOT NULL REFERENCES trials(trial_id),
	purpose TEXT NOT NULL,
	model TEXT,
	ok INTEGER NOT NULL,
	input_tokens INTEGER,
	cached_tokens INTEGER,
	output_tokens INTEGER,
	reasoning_tokens INTEGER,
	calls INTEGER,
	duration_ms INTEGER NOT NULL,
	error TEXT,
	created_at TEXT NOT NULL
);
CREATE TABLE mock_calls(
	id INTEGER PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(run_id),
	trial_id TEXT REFERENCES trials(trial_id),
	seq INTEGER NOT NULL,
	step_id TEXT NOT NULL,
	entry TEXT NOT NULL,
	revision_id TEXT NOT NULL,
	request_digest TEXT NOT NULL,
	reference_digests TEXT NOT NULL,
	arguments_json TEXT,
	arguments_source TEXT NOT NULL,
	scenario TEXT NOT NULL,
	state TEXT NOT NULL,
	code TEXT,
	output_digest TEXT,
	at INTEGER NOT NULL
);
CREATE TABLE checks(
	id INTEGER PRIMARY KEY,
	trial_id TEXT NOT NULL REFERENCES trials(trial_id),
	code TEXT NOT NULL,
	path TEXT NOT NULL,
	severity TEXT NOT NULL,
	message TEXT NOT NULL
);
CREATE TABLE scores(
	id INTEGER PRIMARY KEY,
	trial_id TEXT NOT NULL REFERENCES trials(trial_id),
	scorer TEXT NOT NULL,
	criterion TEXT NOT NULL,
	value REAL,
	label TEXT,
	rationale TEXT,
	reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0, 1)),
	created_at TEXT NOT NULL
);
CREATE INDEX trials_run ON trials(run_id);
CREATE INDEX model_calls_trial ON model_calls(trial_id);
CREATE INDEX mock_calls_run ON mock_calls(run_id, trial_id);
CREATE INDEX scores_trial ON scores(trial_id);
CREATE TRIGGER runs_frozen BEFORE UPDATE ON runs WHEN OLD.status <> 'running'
	BEGIN SELECT RAISE(ABORT, 'run is finished; start a new run'); END;
CREATE TRIGGER trials_frozen BEFORE UPDATE ON trials WHEN OLD.status <> 'running'
	BEGIN SELECT RAISE(ABORT, 'trial is finished; record a new attempt'); END;
CREATE TRIGGER trials_need_open_run BEFORE INSERT ON trials
	WHEN (SELECT status FROM runs WHERE run_id = NEW.run_id) <> 'running'
	BEGIN SELECT RAISE(ABORT, 'run is finished; start a new run'); END;
${["model_calls", "checks"]
	.map(
		(table) =>
			`CREATE TRIGGER ${table}_need_open_trial BEFORE INSERT ON ${table}
	WHEN (SELECT status FROM trials WHERE trial_id = NEW.trial_id) <> 'running'
	BEGIN SELECT RAISE(ABORT, 'trial is finished; record a new attempt'); END;`,
	)
	.join("\n")}
CREATE TRIGGER mock_calls_need_open BEFORE INSERT ON mock_calls
	WHEN (SELECT status FROM runs WHERE run_id = NEW.run_id) <> 'running'
		OR (NEW.trial_id IS NOT NULL AND (SELECT status FROM trials WHERE trial_id = NEW.trial_id) <> 'running')
	BEGIN SELECT RAISE(ABORT, 'run or trial is finished'); END;
${["runs", "trials", "model_calls", "mock_calls", "checks", "scores"]
	.map(
		(table) =>
			`CREATE TRIGGER ${table}_keep BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'bench records are append-only'); END;`,
	)
	.join("\n")}
${["model_calls", "mock_calls", "checks", "scores"]
	.map(
		(table) =>
			`CREATE TRIGGER ${table}_fixed BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'bench records are append-only'); END;`,
	)
	.join("\n")}
`;

export type FinishStatus = "completed" | "failed" | "interrupted";

export type WorkDb = {
	/**
	 * For read queries (reports, tests). Writes go through the methods; the triggers refuse
	 * rewriting finished rows, deleting anything, and REPLACE (recursive triggers are on).
	 */
	db: Database;
	startRun(input: {
		kind: string;
		config: unknown;
		inputs: Record<string, unknown>;
		parentRunId?: string;
		note?: string;
	}): string;
	finishRun(runId: string, status: FinishStatus): void;
	startTrial(input: {
		runId: string;
		caseId: string;
		condition: string;
		attempt: number;
		phase: string;
	}): string;
	finishTrial(
		trialId: string,
		input: { status: FinishStatus; outputText?: string; error?: string },
	): void;
	recordModelCall(
		trialId: string,
		purpose: string,
		result: InferenceResult,
	): void;
	recordMockCall(runId: string, trialId: string | null, call: MockCall): void;
	recordChecks(trialId: string, issues: Issue[]): void;
	recordScore(
		trialId: string,
		score: {
			scorer: string;
			criterion: string;
			value?: number;
			label?: string;
			rationale?: string;
			reviewed?: boolean;
		},
	): void;
	close(): void;
};

const iso = () => new Date().toISOString();

export function openWorkDb(path: string = DEFAULT_WORK_DB): WorkDb {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA foreign_keys = ON");
	// Without this, INSERT OR REPLACE deletes rows without firing the append-only DELETE triggers.
	db.run("PRAGMA recursive_triggers = ON");
	const version =
		db.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version ?? 0;
	if (version === 0) {
		// Only an empty file becomes a work db; never add tables to some other database.
		const objects =
			db
				.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master")
				.get()?.n ?? 0;
		if (objects > 0) {
			db.close();
			throw new Error(
				`${path} is not empty and not a bench work db; refusing to initialize it`,
			);
		}
		if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
		db.transaction(() => {
			db.exec(SCHEMA_V1);
			db.exec(API_BUDGET_SCHEMA);
			db.run(`PRAGMA user_version = ${WORK_DB_VERSION}`);
		})();
	} else if (version === 1) {
		db.transaction(() => {
			db.exec(API_BUDGET_SCHEMA);
			db.run(`PRAGMA user_version = ${WORK_DB_VERSION}`);
		})();
	} else if (version !== WORK_DB_VERSION) {
		db.close();
		throw new Error(
			`work db ${path} is version ${version}; this code expects ${WORK_DB_VERSION}`,
		);
	}

	const changed = (result: { changes: number }, what: string) => {
		if (result.changes !== 1) throw new Error(`${what}: no running row`);
	};

	return {
		db,
		startRun({ kind, config, inputs, parentRunId, note }) {
			const runId = crypto.randomUUID();
			const configJson = canonicalJson(config);
			db.query(
				`INSERT INTO runs(run_id, kind, parent_run_id, created_at, config_json, config_digest, inputs_json, status, note)
				 VALUES ($runId, $kind, $parent, $created, $config, $digest, $inputs, 'running', $note)`,
			).run({
				runId,
				kind,
				parent: parentRunId ?? null,
				created: iso(),
				config: configJson,
				digest: sha256(configJson),
				inputs: canonicalJson({ ...inputs, source: sourceProvenance() }),
				note: note ?? null,
			});
			return runId;
		},
		finishRun(runId, status) {
			changed(
				db
					.query(
						"UPDATE runs SET status = $status, finished_at = $at WHERE run_id = $runId AND status = 'running'",
					)
					.run({ status, at: iso(), runId }),
				`finish run ${runId}`,
			);
		},
		startTrial({ runId, caseId, condition, attempt, phase }) {
			const trialId = crypto.randomUUID();
			db.query(
				`INSERT INTO trials(trial_id, run_id, case_id, condition, attempt, phase, status, started_at)
				 VALUES ($trialId, $runId, $caseId, $condition, $attempt, $phase, 'running', $at)`,
			).run({ trialId, runId, caseId, condition, attempt, phase, at: iso() });
			return trialId;
		},
		finishTrial(trialId, { status, outputText, error }) {
			changed(
				db
					.query(
						`UPDATE trials SET status = $status, finished_at = $at, output_text = $text,
						 output_digest = $digest, error = $error WHERE trial_id = $trialId AND status = 'running'`,
					)
					.run({
						status,
						at: iso(),
						text: outputText ?? null,
						digest: outputText === undefined ? null : sha256(outputText),
						error: error ?? null,
						trialId,
					}),
				`finish trial ${trialId}`,
			);
		},
		recordModelCall(trialId, purpose, result) {
			db.query(
				`INSERT INTO model_calls(trial_id, purpose, model, ok, input_tokens, cached_tokens, output_tokens,
				 reasoning_tokens, calls, duration_ms, error, created_at)
				 VALUES ($trialId, $purpose, $model, $ok, $input, $cached, $output, $reasoning, $calls, $duration, $error, $at)`,
			).run({
				trialId,
				purpose,
				model: result.model,
				ok: result.ok ? 1 : 0,
				input: result.usage.inputTokens,
				cached: result.usage.cachedTokens,
				output: result.usage.outputTokens,
				reasoning: result.usage.reasoningTokens,
				calls: result.usage.calls,
				duration: Math.round(result.durationMs),
				error: result.ok ? null : result.error,
				at: iso(),
			});
		},
		recordMockCall(runId, trialId, call) {
			db.query(
				`INSERT INTO mock_calls(run_id, trial_id, seq, step_id, entry, revision_id, request_digest,
				 reference_digests, arguments_json, arguments_source, scenario, state, code, output_digest, at)
				 VALUES ($runId, $trialId, $seq, $stepId, $entry, $revisionId, $requestDigest, $refs, $args,
				 $argsSource, $scenario, $state, $code, $outputDigest, $at)`,
			).run({
				runId,
				trialId,
				seq: call.seq,
				stepId: call.stepId,
				entry: call.entry,
				revisionId: call.revisionId,
				requestDigest: call.requestDigest,
				refs: JSON.stringify(call.referenceDigests),
				args: call.arguments === null ? null : canonicalJson(call.arguments),
				argsSource: call.argumentsSource,
				scenario: call.scenario,
				state: call.state,
				code: call.code,
				outputDigest: call.outputDigest,
				at: call.at,
			});
		},
		recordChecks(trialId, issues) {
			const insert = db.query(
				"INSERT INTO checks(trial_id, code, path, severity, message) VALUES ($trialId, $code, $path, $severity, $message)",
			);
			db.transaction(() => {
				for (const issue of issues)
					insert.run({
						trialId,
						code: issue.code,
						path: issue.path,
						severity: issue.severity,
						message: issue.message,
					});
			})();
		},
		recordScore(trialId, score) {
			db.query(
				`INSERT INTO scores(trial_id, scorer, criterion, value, label, rationale, reviewed, created_at)
				 VALUES ($trialId, $scorer, $criterion, $value, $label, $rationale, $reviewed, $at)`,
			).run({
				trialId,
				scorer: score.scorer,
				criterion: score.criterion,
				value: score.value ?? null,
				label: score.label ?? null,
				rationale: score.rationale ?? null,
				reviewed: score.reviewed ? 1 : 0,
				at: iso(),
			});
		},
		close: () => db.close(),
	};
}
