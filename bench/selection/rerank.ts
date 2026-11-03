/**
 * The reranker port for the Wave B selection experiment: scores (query, passage) pairs with
 * the PUBLIC `cl-nagoya/ruri-reranker-small` snapshot kept under `~/workspace/tools/`
 * (NOT part of this repo), through the small Python helper next to this module
 * (`rerank_helper.py`), because the model and its custom tokenizer live in the
 * transformers ecosystem.
 *
 * This is the base public model, never the user's retrained production reranker: the
 * production Provider is not touched, and no number from this port may be reported as
 * the production network's score (plan §9; AGENTS.md). Provenance (repo + revision) is
 * read from the `source.json` the download left next to the model files.
 *
 * Substitutable by environment (`PIPELINE_RERANK_PYTHON`, `PIPELINE_RERANK_MODEL`).
 * Any failure — missing interpreter, missing model, helper error, or the reach guard
 * blocking the spawn (as in tests and in runs that did not allow exactly this command) —
 * yields null for the whole batch: the experiment then reports the rerank method as
 * unavailable with a reason, and never fills scores with estimates.
 *
 * This file is on the reach guard's process allowlist (`PROCESS_ALLOWED_FILES`) for the
 * one spawn below; the experiment CLI allows exactly `rerankCommand()` at run time.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RERANK_PYTHON_ENV = "PIPELINE_RERANK_PYTHON";
export const RERANK_MODEL_ENV = "PIPELINE_RERANK_MODEL";

/** The helper script, next to this module. It only reads the model directory and stdin. */
export const RERANK_HELPER = join(import.meta.dir, "rerank_helper.py");

/** The public model this port serves; the revision is read from `source.json`, not baked in. */
export const RERANK_MODEL_ID = "cl-nagoya/ruri-reranker-small";

const DEFAULT_MODEL_DIR = join(
	homedir(),
	"workspace/tools/ruri-reranker/model",
);
const PREFERRED_PYTHON = join(
	homedir(),
	"workspace/tools/ruri-reranker/venv/bin/python",
);

type Env = Record<string, string | undefined>;

export function rerankModelDir(env: Env = process.env): string {
	return env[RERANK_MODEL_ENV] ?? DEFAULT_MODEL_DIR;
}

export function rerankPythonPath(env: Env = process.env): string {
	if (env[RERANK_PYTHON_ENV]) return env[RERANK_PYTHON_ENV];
	return existsSync(PREFERRED_PYTHON) ? PREFERRED_PYTHON : "python3";
}

/** The one command the reranker runs: `[python, helper, modelDir]`. */
export function rerankCommand(env: Env = process.env): string[] {
	return [rerankPythonPath(env), RERANK_HELPER, rerankModelDir(env)];
}

/** The experiment CLI's guard allowance: exactly `rerankCommand()`, nothing else. */
export function isRerankCommand(
	command: readonly string[],
	env: Env = process.env,
): boolean {
	const expected = rerankCommand(env);
	return (
		command.length === expected.length &&
		command.every((part, i) => part === expected[i])
	);
}

/** Runs the helper once and returns its stdout; throws on any failure. Injectable in tests. */
export type RerankScoreRunner = (
	command: readonly string[],
	input: string,
) => string;

const spawnRunner: RerankScoreRunner = (command, input) => {
	const proc = Bun.spawnSync([...command], {
		stdin: Buffer.from(input, "utf8"),
	});
	if (proc.exitCode !== 0)
		throw new Error(
			`rerank helper exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr).slice(0, 200)}`,
		);
	return new TextDecoder().decode(proc.stdout);
};

export type RerankPair = { query: string; passage: string };

/**
 * Score every pair, in order. All-or-nothing: any failure yields null for the whole
 * batch — partially scored candidates would silently skew the comparison.
 */
export function scoreRerankPairs(
	pairs: readonly RerankPair[],
	options: { env?: Env; run?: RerankScoreRunner } = {},
): number[] | null {
	const env = options.env ?? process.env;
	if (pairs.length === 0) return [];
	if (!existsSync(rerankModelDir(env))) return null;
	try {
		const input = `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
		const stdout = (options.run ?? spawnRunner)(rerankCommand(env), input);
		const lines = stdout.split("\n").filter((line) => line.trim() !== "");
		if (lines.length !== pairs.length)
			throw new Error(
				`rerank helper answered ${lines.length} scores for ${pairs.length} pairs`,
			);
		return lines.map((line) => {
			const parsed = JSON.parse(line) as { score?: unknown };
			if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score))
				throw new Error(`rerank helper answered a bad score: ${line}`);
			return parsed.score;
		});
	} catch {
		return null;
	}
}

export type RerankProvenance = {
	model: string;
	/** HF revision (commit) recorded by the download in `source.json`; null when unrecorded. */
	revision: string | null;
	/** The local model directory the scores came from. */
	modelDir: string;
};

/** Where the reranker came from. The revision is recorded provenance, never a constant. */
export function rerankProvenance(env: Env = process.env): RerankProvenance {
	const modelDir = rerankModelDir(env);
	let revision: string | null = null;
	try {
		const source = JSON.parse(
			readFileSync(join(modelDir, "source.json"), "utf8"),
		) as { revision?: unknown };
		if (typeof source.revision === "string") revision = source.revision;
	} catch {
		// No recorded source: revision stays null rather than being guessed.
	}
	return { model: RERANK_MODEL_ID, revision, modelDir };
}
