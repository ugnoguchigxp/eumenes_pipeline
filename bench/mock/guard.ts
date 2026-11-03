/**
 * Reach guard: during tests and offline verification nothing may reach a real tool, the network or
 * another process (plan §10: "実ツールへ到達する呼出しが0件").
 *
 * Runtime half: replaces `fetch`, `WebSocket`, `Worker`, `Bun.spawn`/`spawnSync`/`$`/`connect`/
 * `listen`/`serve`/`udpSocket`/`sql`/`SQL`/`redis`/`RedisClient`/`S3Client`/`s3`, and the default
 * objects of `node:child_process`, `net`, `tls`, `dgram`, `http`, `https`, `http2`, `dns` with
 * throwing stubs that count every attempt.
 *
 * Static half (`guard.test.ts`): what cannot be patched at run time is forbidden in the source of
 * `src/` and `bench/`: importing the banned modules (also via `require` or `getBuiltinModule`),
 * importing values from "bun", `Bun.fetch` (a read-only property), and `Bun["..."]` lookups.
 *
 * A live experiment installs the guard with `allowProcess` for exactly `muse exec` and, once a typed
 * reranker/embedding port exists, `allowFetch` for exactly its endpoint. Everything else stays blocked.
 */
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export type ReachAttempt = { kind: string; target: string };

/**
 * Files allowed to mention `Bun.spawn` (still subject to the runtime guard's `allowProcess`):
 * the Muse inference adapter, the tokenizer counter, whose only process is the local
 * Python helper reading a local tokenizer file (bench/tokens.ts), and the Wave B reranker
 * port, whose only process is the local Python helper scoring pairs with the public
 * reranker snapshot (bench/selection/rerank.ts).
 */
export const PROCESS_ALLOWED_FILES = [
	"bench/infer/muse-exec.ts",
	"bench/tokens.ts",
	"bench/selection/rerank.ts",
];
/** The only file allowed to import the banned modules: this guard, to patch them. */
export const GUARD_FILE = "bench/mock/guard.ts";
/** Node builtins that reach the network, processes or other threads; banned by the static check. */
export const BANNED_MODULES = [
	"child_process",
	"net",
	"http",
	"https",
	"http2",
	"tls",
	"dgram",
	"dns",
	"dns/promises",
	"worker_threads",
	"cluster",
	"inspector",
].flatMap((name) => [name, `node:${name}`]);

type Options = {
	allowProcess?: (command: string[]) => boolean;
	allowFetch?: (url: string) => boolean;
};

const attempts: ReachAttempt[] = [];
let installed: Required<Options> | null = null;

export class ReachBlocked extends Error {
	constructor(readonly attempt: ReachAttempt) {
		super(`blocked ${attempt.kind}: ${attempt.target} (bench reach guard)`);
	}
}

const block = (kind: string, target: string): never => {
	const attempt = { kind, target };
	attempts.push(attempt);
	throw new ReachBlocked(attempt);
};

const describe = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value instanceof URL) return value.href;
	if (value instanceof Request) return value.url;
	try {
		return JSON.stringify(value)?.slice(0, 200) ?? String(value);
	} catch {
		return String(value);
	}
};

/** Function internals a runtime or test reporter may inspect; they stay ordinary. */
const INTROSPECTION = new Set([
	"prototype",
	"name",
	"length",
	"constructor",
	"toString",
	"call",
	"apply",
	"bind",
	"then",
]);

/**
 * A stub that throws (and counts) whether it is called, constructed, used as a tagged template, or
 * reached through a named method (`Bun.sql.unsafe(...)`, `Bun.$.cwd(...)`).
 */
const blocker = (kind: string) =>
	new Proxy(function blocked() {}, {
		apply: (_target, _this, args: unknown[]) => block(kind, describe(args[0])),
		construct: (_target, args: unknown[]) => block(kind, describe(args[0])),
		get: (target, property, receiver) =>
			typeof property === "symbol" || INTROSPECTION.has(property)
				? Reflect.get(target, property, receiver)
				: () => block(`${kind}.${property}`, ""),
	});

/** Install once per process. Allowances can only be given on the first install. */
export function installGuard(options: Options = {}): void {
	if (installed) {
		if (options.allowProcess || options.allowFetch)
			throw new Error(
				"reach guard already installed; pass allowances on the first install",
			);
		return;
	}
	installed = {
		allowProcess: options.allowProcess ?? (() => false),
		allowFetch: options.allowFetch ?? (() => false),
	};
	const { allowProcess, allowFetch } = installed;

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		const url = describe(input);
		if (!allowFetch(url)) block("fetch", url);
		return (realFetch as (...a: unknown[]) => unknown)(input, init);
	}) as unknown as typeof fetch;
	globalThis.WebSocket = blocker("websocket") as unknown as typeof WebSocket;
	globalThis.Worker = blocker("worker") as unknown as typeof Worker;

	const bun = Bun as unknown as Record<string, unknown>;
	const spawn = Bun.spawn;
	const spawnSync = Bun.spawnSync;
	const commandOf = (args: unknown[]): string[] => {
		const first = args[0];
		if (Array.isArray(first)) return first.map(String);
		if (first && typeof first === "object" && "cmd" in first)
			return (first as { cmd: unknown[] }).cmd.map(String);
		return [String(first)];
	};
	bun.spawn = (...args: unknown[]) => {
		const command = commandOf(args);
		if (!allowProcess(command)) block("process", command.join(" "));
		return (spawn as (...a: unknown[]) => unknown)(...args);
	};
	bun.spawnSync = (...args: unknown[]) => {
		const command = commandOf(args);
		if (!allowProcess(command)) block("process", command.join(" "));
		return (spawnSync as (...a: unknown[]) => unknown)(...args);
	};
	for (const name of [
		"$",
		"connect",
		"listen",
		"serve",
		"udpSocket",
		"sql",
		"SQL",
		"redis",
		"RedisClient",
		"S3Client",
		"s3",
	])
		bun[name] = blocker(`bun.${name}`);

	const patch = (target: object, module: string, names: string[]) => {
		const writable = target as Record<string, unknown>;
		for (const name of names)
			if (name in writable) writable[name] = blocker(`${module}.${name}`);
	};
	patch(childProcess, "child_process", [
		"spawn",
		"spawnSync",
		"exec",
		"execSync",
		"execFile",
		"execFileSync",
		"fork",
	]);
	patch(net, "net", ["connect", "createConnection", "createServer", "Socket"]);
	patch(tls, "tls", ["connect", "createServer"]);
	patch(dgram, "dgram", ["createSocket"]);
	patch(http, "http", ["request", "get", "createServer"]);
	patch(https, "https", ["request", "get", "createServer"]);
	patch(http2, "http2", ["connect", "createServer", "createSecureServer"]);
	const resolvers = [
		"lookup",
		"lookupService",
		"resolve",
		"resolve4",
		"resolve6",
		"resolveAny",
		"resolveCname",
		"resolveMx",
		"resolveNs",
		"resolveTxt",
		"resolveSrv",
		"reverse",
		"Resolver",
	];
	patch(dns, "dns", resolvers);
	if (dns.promises) patch(dns.promises, "dns.promises", resolvers);
}

export const guardInstalled = (): boolean => installed !== null;

/** Attempts since the guard was installed (or since the last `takeReachAttempts`). */
export function takeReachAttempts(): ReachAttempt[] {
	return attempts.splice(0, attempts.length);
}

export const reachAttemptCount = (): number => attempts.length;

/**
 * For live experiments: allow exactly `muse exec` (the bench's inference path) and nothing else.
 *   installGuard({ allowProcess: allowMuseExec() })
 */
export const allowMuseExec =
	(binary = "muse") =>
	(command: string[]): boolean =>
		command[0] === binary && command[1] === "exec";
