import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
	isolatedDir,
	MuseExecInference,
	parseMuseJsonl,
	SYSTEM_SEPARATOR,
	type ProcessRunner,
} from "./muse-exec.ts";

// Trimmed from a real `muse exec --json --provider echo` run (Muse Code 1.4.14).
const ECHO_JSONL = [
	'{"schema_version":1,"payload_type":"run.lifecycle.started","payload":{"kind":"run_started"}}',
	'{"schema_version":1,"payload_type":"run.output.delta","payload":{"kind":"run_output_delta","text":"echo: hi"}}',
	'{"schema_version":1,"payload_type":"run.usage","payload":{"kind":"run_usage","models":[{"model":null,"input_tokens":0,"cached_tokens":0,"output_tokens":0,"reasoning_tokens":0,"calls":1}],"calls":1,"completed_calls":1,"failed_calls":0,"cancelled_calls":0,"children_included":false,"allowance":null}}',
	'{"schema_version":1,"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"echo: hi","reason":null}}',
].join("\n");

describe("parseMuseJsonl", () => {
	test("reads the final text and usage", () => {
		expect(parseMuseJsonl(ECHO_JSONL)).toEqual({
			terminal: "completed",
			text: "echo: hi",
			reason: null,
			model: null,
			usage: {
				inputTokens: 0,
				cachedTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				calls: 1,
			},
			malformedLines: 0,
		});
	});

	test("sums models, keeps unreported counts null, counts junk lines", () => {
		const parsed = parseMuseJsonl(
			[
				"not json",
				'{"payload_type":"run.usage","payload":{"calls":3,"models":[{"model":"a","input_tokens":5,"output_tokens":2,"cached_tokens":1,"reasoning_tokens":null},{"model":"b","input_tokens":7,"output_tokens":3,"cached_tokens":0,"reasoning_tokens":4}]}}',
				'{"payload_type":"run.terminal.failed","payload":{"terminal":"failed","text":null,"reason":"quota"}}',
			].join("\n"),
		);
		expect(parsed.usage).toEqual({
			inputTokens: 12,
			cachedTokens: 1,
			outputTokens: 5,
			reasoningTokens: null,
			calls: 3,
		});
		expect(parsed.model).toBe("a,b");
		expect(parsed).toMatchObject({
			terminal: "failed",
			reason: "quota",
			malformedLines: 1,
		});
	});

	test("no usage event means unknown counts, not zeros", () => {
		expect(parseMuseJsonl("").usage).toEqual({
			inputTokens: null,
			cachedTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			calls: null,
		});
	});
});

describe("MuseExecInference", () => {
	test("runs isolated outside the repository with the prompt and schema files", async () => {
		const seen: {
			command: string[];
			cwd: string;
			prompt: string;
			schema: unknown;
		}[] = [];
		const run: ProcessRunner = async (command, { cwd }) => {
			const promptFile = command[command.indexOf("--prompt-file") + 1] ?? "";
			const schemaFile = command[command.indexOf("--output-schema") + 1] ?? "";
			seen.push({
				command,
				cwd,
				prompt: readFileSync(promptFile, "utf8"),
				schema: JSON.parse(readFileSync(schemaFile, "utf8")),
			});
			return { exitCode: 0, stdout: ECHO_JSONL, stderr: "", timedOut: false };
		};
		const muse = new MuseExecInference({ model: "m-1", effort: "low", run });
		const result = await muse.complete({
			purpose: "compose",
			system: "規則",
			prompt: "依頼",
			outputSchema: { type: "object" },
		});
		expect(result).toMatchObject({ ok: true, text: "echo: hi", model: "m-1" });
		const call = seen[0];
		expect(call?.prompt).toBe(`規則${SYSTEM_SEPARATOR}依頼`);
		expect(call?.schema).toEqual({ type: "object" });
		expect(call?.cwd.startsWith(resolve("."))).toBe(false);
		expect(existsSync(call?.cwd ?? "")).toBe(false); // removed after the call
		for (const flag of [
			"--json",
			"--disable-reminders",
			"--disable-web-tools",
			"--disable-request-user-input",
			"--no-foreign-personal-context",
			"--no-session-log",
		])
			expect(call?.command).toContain(flag);
		expect(call?.command.slice(0, 5)).toEqual([
			"muse",
			"exec",
			"--json",
			"--preset",
			"empty",
		]);
		expect(call?.command).toEqual(
			expect.arrayContaining(["--model", "m-1", "--reasoning-effort", "low"]),
		);
	});

	test("reports failure, timeout and missing terminal as errors with usage kept", async () => {
		const answer = (outcome: Awaited<ReturnType<ProcessRunner>>) =>
			new MuseExecInference({ run: async () => outcome }).complete({
				purpose: "p",
				prompt: "x",
			});
		const timeout = await answer({
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: true,
		});
		expect(timeout).toMatchObject({ ok: false, error: "timeout" });
		const failed = await answer({
			exitCode: 1,
			stdout:
				'{"payload_type":"run.terminal.failed","payload":{"terminal":"failed","reason":"auth"}}',
			stderr: "muse: login required",
			timedOut: false,
		});
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error).toContain("auth");
	});
});

describe("Muse adapter hardening", () => {
	test("non-object JSON lines are malformed, not a crash", () => {
		const parsed = parseMuseJsonl(["null", "[]", "3", ECHO_JSONL].join("\n"));
		expect(parsed.malformedLines).toBe(3);
		expect(parsed.text).toBe("echo: hi");
	});

	test("a usage event without calls or model names stays unknown", () => {
		const parsed = parseMuseJsonl(
			'{"payload_type":"run.usage","payload":{"models":[{"input_tokens":1,"output_tokens":1,"cached_tokens":0,"reasoning_tokens":0}]}}',
		);
		expect(parsed.usage.calls).toBeNull();
		expect(parsed.model).toBeNull();
	});

	test("refuses a temp directory inside the repository", () => {
		expect(() => isolatedDir(resolve("."))).toThrow("inside the repository");
		const outside = isolatedDir();
		expect(existsSync(outside)).toBe(true);
		rmSync(outside, { recursive: true, force: true });
	});
});
