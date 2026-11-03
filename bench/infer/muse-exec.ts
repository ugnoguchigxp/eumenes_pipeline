/**
 * InferencePort over Muse Code's headless mode (`muse exec --json`), the bench's inference path.
 * Credentials stay inside Muse; this adapter only starts the process and reads its JSONL events.
 *
 * Isolation (plan §9/§10: the composing model sees only what the case gives it):
 * - every call runs in a fresh empty temp directory OUTSIDE this repository, so Muse never loads
 *   this repo's AGENTS.md, cases or gold labels as project context;
 * - `--preset empty`, web tools, reminders, user questions and personal context are disabled;
 * - session logs are not persisted.
 *
 * Usage comes from the `run.usage` event (input / cached / output / reasoning tokens, calls). A value
 * Muse does not report stays null. Muse has no system-prompt flag in exec mode, so `system` is
 * prepended to the prompt with a separator; this is recorded by the caller as part of the prompt.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
	InferencePort,
	InferenceRequest,
	InferenceResult,
	InferenceUsage,
} from "../../src/ports.ts";

export type ProcessOutcome = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};
export type ProcessRunner = (
	command: string[],
	options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<ProcessOutcome>;

export type MuseExecOptions = {
	binary?: string;
	provider?: "meta" | "echo";
	model?: string;
	effort?:
		"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
	timeoutMs?: number;
	extraArgs?: string[];
	/** Injected in tests; defaults to `Bun.spawn`. */
	run?: ProcessRunner;
};

export const SYSTEM_SEPARATOR = "\n\n---\n\n";

const REPO_ROOT = realpathSync(resolve(import.meta.dir, "../.."));

/**
 * A fresh empty directory outside this repository. If TMPDIR points inside the repo, Muse would load
 * this repo's AGENTS.md and could read cases, so the call is refused instead.
 */
export function isolatedDir(base: string = tmpdir()): string {
	const dir = realpathSync(mkdtempSync(join(base, "eumenes-pipeline-muse-")));
	const rel = relative(REPO_ROOT, dir);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(
			`temp dir ${dir} is inside the repository; set TMPDIR outside it`,
		);
	}
	return dir;
}

const KILL_GRACE_MS = 5_000;

const spawnRunner: ProcessRunner = async (
	command,
	{ cwd, timeoutMs, signal },
) => {
	const child = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		...(signal ? { signal } : {}),
	});
	let timedOut = false;
	let killer: ReturnType<typeof setTimeout> | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		// A process that ignores SIGTERM must not keep the bench waiting forever.
		killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
		clearTimeout(killer);
	}
};

type MuseEvent = {
	payload_type?: string;
	payload?: {
		terminal?: string;
		text?: string | null;
		reason?: string | null;
		calls?: number;
		models?: Array<{
			model: string | null;
			input_tokens?: number | null;
			cached_tokens?: number | null;
			output_tokens?: number | null;
			reasoning_tokens?: number | null;
			calls?: number;
		}>;
	};
};

export type ParsedMuseOutput = {
	terminal: string | null;
	text: string | null;
	reason: string | null;
	model: string | null;
	usage: InferenceUsage;
	malformedLines: number;
};

/** Parse `muse exec --json` stdout. Exported for tests and for re-reading recorded output. */
export function parseMuseJsonl(stdout: string): ParsedMuseOutput {
	let terminal: string | null = null;
	let text: string | null = null;
	let reason: string | null = null;
	let usageEvent: MuseEvent["payload"] | null = null;
	let malformedLines = 0;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: MuseEvent;
		try {
			event = JSON.parse(line) as MuseEvent;
		} catch {
			malformedLines += 1;
			continue;
		}
		if (!event || typeof event !== "object" || Array.isArray(event)) {
			malformedLines += 1;
			continue;
		}
		if (event.payload_type === "run.usage") usageEvent = event.payload ?? null;
		else if (event.payload_type?.startsWith("run.terminal.")) {
			terminal = event.payload?.terminal ?? event.payload_type.slice(13);
			text = event.payload?.text ?? null;
			reason = event.payload?.reason ?? null;
		}
	}
	const models = usageEvent?.models ?? [];
	const sum = (
		key:
			"input_tokens" | "cached_tokens" | "output_tokens" | "reasoning_tokens",
	) =>
		models.length === 0 || models.some((m) => typeof m[key] !== "number")
			? null
			: models.reduce((total, m) => total + (m[key] ?? 0), 0);
	const named = [
		...new Set(
			models
				.map((m) => m.model)
				.filter((m): m is string => typeof m === "string" && m.length > 0),
		),
	];
	return {
		terminal,
		text,
		reason,
		model: named.length ? named.join(",") : null,
		usage: {
			inputTokens: sum("input_tokens"),
			cachedTokens: sum("cached_tokens"),
			outputTokens: sum("output_tokens"),
			reasoningTokens: sum("reasoning_tokens"),
			calls: typeof usageEvent?.calls === "number" ? usageEvent.calls : null,
		},
		malformedLines,
	};
}

export class MuseExecInference implements InferencePort {
	readonly #options: MuseExecOptions;
	constructor(options: MuseExecOptions = {}) {
		this.#options = options;
	}

	/** The argv for one call (without the binary's prompt/schema file paths filled in). */
	args(promptFile: string, schemaFile: string | null): string[] {
		const o = this.#options;
		return [
			o.binary ?? "muse",
			"exec",
			"--json",
			"--preset",
			"empty",
			"--provider",
			o.provider ?? "meta",
			"--disable-reminders",
			"--disable-web-tools",
			"--disable-request-user-input",
			"--no-foreign-personal-context",
			"--no-session-log",
			...(o.model ? ["--model", o.model] : []),
			...(o.effort ? ["--reasoning-effort", o.effort] : []),
			...(schemaFile ? ["--output-schema", schemaFile] : []),
			...(o.extraArgs ?? []),
			"--prompt-file",
			promptFile,
		];
	}

	async complete(
		request: InferenceRequest,
		signal?: AbortSignal,
	): Promise<InferenceResult> {
		const started = performance.now();
		const dir = isolatedDir();
		try {
			const promptFile = join(dir, "prompt.txt");
			writeFileSync(
				promptFile,
				request.system
					? `${request.system}${SYSTEM_SEPARATOR}${request.prompt}`
					: request.prompt,
			);
			let schemaFile: string | null = null;
			if (request.outputSchema) {
				schemaFile = join(dir, "output-schema.json");
				writeFileSync(schemaFile, JSON.stringify(request.outputSchema));
			}
			const run = this.#options.run ?? spawnRunner;
			const outcome = await run(this.args(promptFile, schemaFile), {
				cwd: dir,
				timeoutMs: this.#options.timeoutMs ?? 300_000,
				...(signal ? { signal } : {}),
			});
			const parsed = parseMuseJsonl(outcome.stdout);
			const durationMs = performance.now() - started;
			const base = {
				model: parsed.model ?? this.#options.model ?? null,
				usage: parsed.usage,
				durationMs,
			};
			if (outcome.timedOut) return { ok: false, error: "timeout", ...base };
			if (parsed.terminal === "completed" && parsed.text !== null)
				return { ok: true, text: parsed.text, ...base };
			return {
				ok: false,
				error: [
					`terminal=${parsed.terminal ?? "none"}`,
					parsed.reason,
					`exit=${outcome.exitCode}`,
					outcome.stderr.trim().split("\n").slice(-3).join(" | "),
				]
					.filter(Boolean)
					.join("; "),
				...base,
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}
