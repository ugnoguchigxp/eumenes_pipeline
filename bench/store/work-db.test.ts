import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkDb } from "./work-db.ts";
import { apiBudget } from "./api-budget.ts";

test("version-one migration preserves completed runs and shares the budget across connections", () => {
	const dir = mkdtempSync(join(tmpdir(), "work-db-migration-"));
	const path = join(dir, "work.sqlite3");
	const original = openWorkDb(path);
	const runId = original.startRun({
		kind: "legacy",
		config: { retained: true },
		inputs: {},
	});
	original.finishRun(runId, "completed");
	const before = original.db
		.query("SELECT * FROM runs WHERE run_id = ?")
		.get(runId);
	original.close();
	const old = new Database(path);
	old.run("DROP TABLE api_budget_events");
	old.run("DROP TABLE api_budgets");
	old.run("PRAGMA user_version = 1");
	old.close();
	const migrated = openWorkDb(path);
	const second = openWorkDb(path);
	try {
		expect(
			migrated.db.query("SELECT * FROM runs WHERE run_id = ?").get(runId),
		).toEqual(before);
		expect(() =>
			migrated.db.run("UPDATE runs SET note='changed' WHERE run_id=?", [runId]),
		).toThrow("finished");
		const one = apiBudget(migrated.db, "shared", 1);
		const two = apiBudget(second.db, "shared", 1);
		const reservation = one.reserve(0.7, {});
		expect(() => two.reserve(0.4, {})).toThrow("exhausted");
		two.settle(reservation, 0.1, {});
		one.reserve(0.8, {});
		expect(two.status().committedCostCeilingUsd).toBe(0.9);
	} finally {
		migrated.close();
		second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

const usage = {
	inputTokens: 10,
	cachedTokens: null,
	outputTokens: 5,
	reasoningTokens: null,
	calls: 1,
};

describe("work db", () => {
	test("records a run with trials, usage, checks and scores", () => {
		const db = openWorkDb(":memory:");
		const runId = db.startRun({
			kind: "test",
			config: { b: 1, a: 2 },
			inputs: { catalog: "x" },
		});
		const trialId = db.startTrial({
			runId,
			caseId: "c1",
			condition: "json",
			attempt: 1,
			phase: "generate",
		});
		db.recordModelCall(trialId, "compose", {
			ok: true,
			text: "{}",
			model: "m",
			usage,
			durationMs: 12.4,
		});
		db.recordChecks(trialId, [
			{
				code: "unused_result",
				path: "steps.0",
				message: "m",
				severity: "warning",
			},
		]);
		db.recordScore(trialId, { scorer: "auto", criterion: "schema", value: 1 });
		db.finishTrial(trialId, { status: "completed", outputText: "{}" });
		db.finishRun(runId, "completed");
		const call = db.db
			.query("SELECT input_tokens, cached_tokens, duration_ms FROM model_calls")
			.get();
		expect(call).toEqual({
			input_tokens: 10,
			cached_tokens: null,
			duration_ms: 12,
		});
		const run = db.db
			.query<{ config_json: string }, []>("SELECT config_json FROM runs")
			.get();
		expect(run?.config_json).toBe('{"a":2,"b":1}');
		db.close();
	});

	test("finished trials and runs cannot change; nothing can be deleted", () => {
		const db = openWorkDb(":memory:");
		const runId = db.startRun({ kind: "test", config: {}, inputs: {} });
		const trialId = db.startTrial({
			runId,
			caseId: "c",
			condition: "x",
			attempt: 1,
			phase: "p",
		});
		db.finishTrial(trialId, { status: "failed", error: "boom" });
		expect(() => db.finishTrial(trialId, { status: "completed" })).toThrow();
		expect(() => db.db.run("UPDATE trials SET output_text = 'x'")).toThrow(
			"trial is finished",
		);
		expect(() => db.db.run("DELETE FROM trials")).toThrow("append-only");
		db.finishRun(runId, "completed");
		expect(() => db.db.run("UPDATE runs SET note = 'x'")).toThrow(
			"run is finished",
		);
		db.close();
	});

	test("the same case, condition, attempt and phase cannot be recorded twice in a run", () => {
		const db = openWorkDb(":memory:");
		const runId = db.startRun({ kind: "test", config: {}, inputs: {} });
		const trial = {
			runId,
			caseId: "c",
			condition: "x",
			attempt: 1,
			phase: "p",
		};
		db.startTrial(trial);
		expect(() => db.startTrial(trial)).toThrow();
		expect(() => db.startTrial({ ...trial, attempt: 2 })).not.toThrow();
		db.close();
	});

	test("a retried experiment is a new run linked to its parent", () => {
		const db = openWorkDb(":memory:");
		const first = db.startRun({ kind: "test", config: {}, inputs: {} });
		db.finishRun(first, "interrupted");
		const second = db.startRun({
			kind: "test",
			config: {},
			inputs: {},
			parentRunId: first,
		});
		const row = db.db
			.query<{ parent_run_id: string }, [string]>(
				"SELECT parent_run_id FROM runs WHERE run_id = ?",
			)
			.get(second);
		expect(row?.parent_run_id).toBe(first);
		db.close();
	});
});

describe("work db holes found in review", () => {
	test("REPLACE cannot overwrite a finished row", () => {
		const db = openWorkDb(":memory:");
		const runId = db.startRun({ kind: "test", config: {}, inputs: {} });
		const trialId = db.startTrial({
			runId,
			caseId: "c",
			condition: "x",
			attempt: 1,
			phase: "p",
		});
		db.recordScore(trialId, { scorer: "auto", criterion: "k", value: 1 });
		db.finishTrial(trialId, { status: "completed", outputText: "real" });
		expect(() =>
			db.db.run(
				`INSERT OR REPLACE INTO trials(trial_id, run_id, case_id, condition, attempt, phase, status, started_at, output_text)
				 VALUES ('${trialId}', '${runId}', 'c', 'x', 1, 'p', 'completed', 'now', 'FORGED')`,
			),
		).toThrow();
		expect(() =>
			db.db.run(
				"REPLACE INTO scores(id, trial_id, scorer, criterion, value, created_at) VALUES (1, 'x', 's', 'k', 0, 'now')",
			),
		).toThrow();
		const row = db.db
			.query<{ output_text: string }, []>("SELECT output_text FROM trials")
			.get();
		expect(row?.output_text).toBe("real");
		db.close();
	});

	test("finished runs take no new trials; finished trials take no new calls or checks", () => {
		const db = openWorkDb(":memory:");
		const runId = db.startRun({ kind: "test", config: {}, inputs: {} });
		const trialId = db.startTrial({
			runId,
			caseId: "c",
			condition: "x",
			attempt: 1,
			phase: "p",
		});
		db.finishTrial(trialId, { status: "completed" });
		expect(() =>
			db.recordModelCall(trialId, "late", {
				ok: true,
				text: "",
				model: null,
				usage,
				durationMs: 0,
			}),
		).toThrow("trial is finished");
		expect(() =>
			db.recordChecks(trialId, [
				{ code: "schema", path: "", message: "m", severity: "error" },
			]),
		).toThrow("trial is finished");
		// Scores may come after the trial (grading is a later step), but never rewrite it.
		expect(() =>
			db.recordScore(trialId, { scorer: "judge", criterion: "k", value: 1 }),
		).not.toThrow();
		db.finishRun(runId, "completed");
		expect(() =>
			db.startTrial({
				runId,
				caseId: "c2",
				condition: "x",
				attempt: 1,
				phase: "p",
			}),
		).toThrow("run is finished");
		db.close();
	});

	test("refuses to initialize a database that is not empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "work-db-test-"));
		try {
			const path = join(dir, "other.sqlite3");
			const other = new Database(path, { create: true });
			other.run("CREATE TABLE precious(x)");
			other.close();
			expect(() => openWorkDb(path)).toThrow("refusing to initialize");
			const check = new Database(path, { readonly: true });
			const tables = check
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.all()
				.map((t) => t.name);
			check.close();
			expect(tables).toEqual(["precious"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("model call usage may be unknown", () => {
		const db = openWorkDb(":memory:");
		const runId = db.startRun({ kind: "test", config: {}, inputs: {} });
		const trialId = db.startTrial({
			runId,
			caseId: "c",
			condition: "x",
			attempt: 1,
			phase: "p",
		});
		db.recordModelCall(trialId, "compose", {
			ok: false,
			error: "timeout",
			model: null,
			usage: {
				inputTokens: null,
				cachedTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				calls: null,
			},
			durationMs: 1,
		});
		const row = db.db
			.query<{ calls: number | null }, []>("SELECT calls FROM model_calls")
			.get();
		expect(row?.calls).toBeNull();
		db.close();
	});
});
