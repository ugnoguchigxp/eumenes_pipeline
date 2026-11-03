/**
 * Token counting for run records (plan §10): prompts and outputs are counted with the
 * tokenizer of the model family the pipeline targets (LFM2.5), so formats and conditions
 * can be compared by description size without calling the model. The tokenizer file is
 * downloaded once under `~/workspace/tools/lfm-tokenizer/` (NOT part of this repo) and the
 * counting itself runs in the `tokenizers` Python library through a small helper
 * (`tokenizer_helper.py`), because that is where the reference implementation lives.
 *
 * Nothing is hardcoded and nothing is estimated:
 * - The Python interpreter and the tokenizer file are substitutable by environment
 *   (`PIPELINE_TOKENIZER_PYTHON`, `PIPELINE_TOKENIZER_FILE`).
 * - When either is unavailable — missing file, missing library, or the reach guard
 *   blocking the spawn (as it does in tests and in any run that did not allow exactly
 *   this command) — every count is null. A count is never replaced by a character
 *   count or a guess (plan §10, AGENTS.md).
 *
 * This file is on the reach guard's process allowlist (`PROCESS_ALLOWED_FILES`) for the
 * one spawn below; the format CLI allows exactly `tokenizerCommand()` at run time.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOKENIZER_PYTHON_ENV = "PIPELINE_TOKENIZER_PYTHON";
export const TOKENIZER_FILE_ENV = "PIPELINE_TOKENIZER_FILE";

/** The helper script, next to this module. It only reads the tokenizer file and stdin. */
export const TOKENIZER_HELPER = join(import.meta.dir, "tokenizer_helper.py");

const DEFAULT_TOKENIZER_FILE = join(
	homedir(),
	"workspace/tools/lfm-tokenizer/tokenizer.json",
);
const PREFERRED_PYTHON = join(
	homedir(),
	"workspace/tools/e5-provider/venv/bin/python",
);

type Env = Record<string, string | undefined>;

export function tokenizerFilePath(env: Env = process.env): string {
	return env[TOKENIZER_FILE_ENV] ?? DEFAULT_TOKENIZER_FILE;
}

export function tokenizerPythonPath(env: Env = process.env): string {
	if (env[TOKENIZER_PYTHON_ENV]) return env[TOKENIZER_PYTHON_ENV];
	return existsSync(PREFERRED_PYTHON) ? PREFERRED_PYTHON : "python3";
}

/** The one command the tokenizer counting runs: `[python, helper, tokenizer.json]`. */
export function tokenizerCommand(env: Env = process.env): string[] {
	return [tokenizerPythonPath(env), TOKENIZER_HELPER, tokenizerFilePath(env)];
}

/** The format CLI's guard allowance: exactly `tokenizerCommand()`, nothing else. */
export function isTokenizerCommand(
	command: readonly string[],
	env: Env = process.env,
): boolean {
	const expected = tokenizerCommand(env);
	return (
		command.length === expected.length &&
		command.every((part, i) => part === expected[i])
	);
}

/** Runs the helper once and returns its stdout; throws on any failure. Injectable in tests. */
export type TokenCountRunner = (
	command: readonly string[],
	input: string,
) => string;

const spawnRunner: TokenCountRunner = (command, input) => {
	const proc = Bun.spawnSync([...command], {
		stdin: Buffer.from(input, "utf8"),
	});
	if (proc.exitCode !== 0)
		throw new Error(
			`tokenizer helper exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr).slice(0, 200)}`,
		);
	return new TextDecoder().decode(proc.stdout);
};

/**
 * Count the tokens of every text, in order. All-or-nothing per call: any failure (no
 * tokenizer file, helper error, blocked spawn, malformed reply) yields null for every
 * text — a partially counted batch would silently skew comparisons.
 */
export function countTokens(
	texts: readonly string[],
	options: { env?: Env; run?: TokenCountRunner } = {},
): (number | null)[] {
	const env = options.env ?? process.env;
	if (texts.length === 0) return [];
	if (!existsSync(tokenizerFilePath(env))) return texts.map(() => null);
	try {
		const input = `${texts.map((text) => JSON.stringify({ text })).join("\n")}\n`;
		const stdout = (options.run ?? spawnRunner)(tokenizerCommand(env), input);
		const lines = stdout.split("\n").filter((line) => line.trim() !== "");
		if (lines.length !== texts.length)
			throw new Error(
				`tokenizer helper answered ${lines.length} counts for ${texts.length} texts`,
			);
		return lines.map((line) => {
			const parsed = JSON.parse(line) as { count?: unknown };
			if (
				typeof parsed.count !== "number" ||
				!Number.isInteger(parsed.count) ||
				parsed.count < 0
			)
				throw new Error(`tokenizer helper answered a bad count: ${line}`);
			return parsed.count;
		});
	} catch {
		return texts.map(() => null);
	}
}

export type TokenizerProvenance = {
	/** The helper actually answered a probe count in this environment. */
	available: boolean;
	/** HF repo the tokenizer file came from, when the download recorded it; else null. */
	repo: string | null;
	/** HF revision (commit) of that repo, when recorded; else null. */
	revision: string | null;
	/** The tokenizer file in use; null when no file is present. */
	file: string | null;
	/** sha256 of the tokenizer file; null when no file is present. */
	sha256: string | null;
};

/**
 * Where the counts of a run came from. `repo`/`revision` are read from the `source.json`
 * the download left next to the tokenizer file — provenance is recorded, never baked
 * into code (plan §10). `available` probes the helper with one empty text.
 */
export function tokenizerProvenance(
	options: { env?: Env; run?: TokenCountRunner } = {},
): TokenizerProvenance {
	const env = options.env ?? process.env;
	const file = tokenizerFilePath(env);
	if (!existsSync(file))
		return {
			available: false,
			repo: null,
			revision: null,
			file: null,
			sha256: null,
		};
	let repo: string | null = null;
	let revision: string | null = null;
	try {
		const source = JSON.parse(
			readFileSync(join(dirname(file), "source.json"), "utf8"),
		) as { repo?: unknown; revision?: unknown };
		if (typeof source.repo === "string") repo = source.repo;
		if (typeof source.revision === "string") revision = source.revision;
	} catch {
		// No recorded source: repo/revision stay null; the file digest still identifies it.
	}
	const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
	const probe = countTokens([""], options);
	return { available: probe[0] != null, repo, revision, file, sha256 };
}
