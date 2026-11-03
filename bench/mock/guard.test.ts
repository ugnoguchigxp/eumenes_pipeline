import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	allowMuseExec,
	BANNED_MODULES,
	GUARD_FILE,
	guardInstalled,
	PROCESS_ALLOWED_FILES,
	ReachBlocked,
	takeReachAttempts,
} from "./guard.ts";

const root = join(import.meta.dir, "../..");
/** This test needs the banned modules to prove the runtime patch; it is the only other exception. */
const GUARD_TEST_FILE = "bench/mock/guard.test.ts";
const sources = (dir: string): string[] =>
	readdirSync(join(root, dir)).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(join(root, path)).isDirectory()) return sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
const text = (file: string) => readFileSync(join(root, file), "utf8");
/** Module specifiers of static imports/re-exports, side-effect imports, dynamic imports and require. */
const imports = (file: string) =>
	[
		...text(file).matchAll(
			/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/gm,
		),
	].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
const scanned = () =>
	[...sources("src"), ...sources("bench")].filter(
		(file) => file !== GUARD_FILE && file !== GUARD_TEST_FILE,
	);

describe("reach guard (runtime)", () => {
	test("is installed for every test process", () => {
		expect(guardInstalled()).toBe(true);
	});

	test("blocks network, processes, threads and services, and counts the attempts", async () => {
		takeReachAttempts();
		await expect(fetch("https://example.invalid")).rejects.toBeInstanceOf(
			ReachBlocked,
		);
		expect(() => Bun.spawn(["echo", "x"])).toThrow(ReachBlocked);
		expect(() => Bun.spawnSync(["echo", "x"])).toThrow(ReachBlocked);
		expect(() => Bun.$`echo x`).toThrow(ReachBlocked);
		expect(() => new WebSocket("wss://example.invalid")).toThrow(ReachBlocked);
		expect(() => new Worker("./x.ts")).toThrow(ReachBlocked);
		expect(() => Bun.sql`select 1`).toThrow(ReachBlocked);
		// The runtime patch covers the default export; named imports are the static check's job.
		const dns = (await import("node:dns")).default;
		expect(() => dns.lookup("example.invalid", () => {})).toThrow(ReachBlocked);
		await expect(
			Promise.resolve().then(() => dns.promises.lookup("example.invalid")),
		).rejects.toBeInstanceOf(ReachBlocked);
		expect(takeReachAttempts().map((a) => a.kind)).toEqual([
			"fetch",
			"process",
			"process",
			"bun.$",
			"websocket",
			"worker",
			"bun.sql",
			"dns.lookup",
			"dns.promises.lookup",
		]);
	});
});

describe("reach guard (static)", () => {
	test("no source imports or requires network, process or thread modules", () => {
		const offenders = scanned().flatMap((file) =>
			imports(file)
				.filter((m) => BANNED_MODULES.includes(m))
				.map((m) => `${file}: ${m}`),
		);
		expect(offenders).toEqual([]);
	});

	test("no source uses what the runtime guard cannot patch", () => {
		const rules: Array<[string, RegExp]> = [
			["Bun.fetch (read-only, cannot be patched)", /\bBun\.fetch\b/],
			["computed Bun property", /\bBun\s*\[/],
			[
				"value import from bun",
				/^\s*import\s+(?!type\b)[^;]*?from\s*["']bun["']/m,
			],
			["getBuiltinModule", /\bgetBuiltinModule\b/],
			["require", /\brequire\s*\(/],
		];
		const offenders = scanned().flatMap((file) =>
			rules
				.filter(([, pattern]) => pattern.test(text(file)))
				.map(([rule]) => `${file}: ${rule}`),
		);
		expect(offenders).toEqual([]);
	});

	test("only the Muse adapter starts processes", () => {
		const offenders = scanned()
			.filter(
				(file) =>
					!PROCESS_ALLOWED_FILES.includes(file) && !file.endsWith(".test.ts"),
			)
			.filter((file) => /\bBun\.(spawn|spawnSync|\$)/.test(text(file)));
		expect(offenders).toEqual([]);
	});
});

describe("library purity (Eumenes integration, plan §6-§7)", () => {
	test("src/ imports only zod and its own modules: no Bun, node, bench or Eumenes", () => {
		const sourceFiles = sources("src").filter(
			(file) => !file.endsWith(".test.ts"),
		);
		const offenders = sourceFiles.flatMap((file) =>
			imports(file)
				.filter(
					(m) =>
						!(
							m === "zod" ||
							(m.startsWith(".") && join(dirname(file), m).startsWith("src/"))
						),
				)
				.map((m) => `${file}: ${m}`),
		);
		expect(sourceFiles.length).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	test("src/ does not use Bun or DOM globals", () => {
		const offenders = sources("src")
			.filter((file) => !file.endsWith(".test.ts"))
			.filter((file) => /\bBun\.|\bdocument\.|\bwindow\./.test(text(file)));
		expect(offenders).toEqual([]);
	});
});

describe("allowMuseExec", () => {
	test("allows only `muse exec`", () => {
		const allow = allowMuseExec();
		expect(allow(["muse", "exec", "--json"])).toBe(true);
		expect(allow(["muse", "login"])).toBe(false);
		expect(allow(["sh", "-c", "muse exec"])).toBe(false);
	});
});
