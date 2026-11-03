/**
 * Build and pack `eumenes-pipeline` the way Eumenes vendors its packages (plan §7):
 * `artifacts/<name>-<version>-<sourceDigest12>/` holding the `.tgz`, its `.sha256` and `manifest.json`
 * (the layout of Eumenes' `vendor/<package>/`), then install the
 * tarball into an empty consumer outside this repository and check its public API and types.
 *
 *   bun scripts/pack.ts --dry-run   build, list the packed files, check them; write nothing
 *   bun scripts/pack.ts             also write the artifact, checksum and manifest, and run the consumer check
 *
 * It never touches Eumenes. Copying the artifact to `../eumenes/vendor/pipeline/` is a separate,
 * approved step (plan §7 step 6).
 */
import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
const dryRun = values["dry-run"] === true;
const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	name: string;
	version: string;
};

const run = (command: string[], cwd = root) => {
	const result = Bun.spawnSync(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`${command.join(" ")} failed (${result.exitCode}):\n${result.stderr.toString()}${result.stdout.toString()}`,
		);
	return result.stdout.toString();
};
const sha256 = (data: Uint8Array | string) =>
	createHash("sha256").update(data).digest("hex");

// The source digest covers what the artifact is built from.
const files = (dir: string): string[] =>
	readdirSync(join(root, dir)).flatMap((name) => {
		const path = join(dir, name);
		return statSync(join(root, path)).isDirectory() ? files(path) : [path];
	});
const sourceFiles = [
	...files("src").filter(
		(f) => !f.endsWith(".test.ts") && !f.endsWith("test-support.ts"),
	),
	"package.json",
	"bun.lock",
	"tsconfig.json",
	"tsconfig.build.json",
].sort();
const sourceDigest = sha256(
	sourceFiles
		.map((f) => `${f}\0${sha256(readFileSync(join(root, f)))}`)
		.join("\n"),
);
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
const gitSha = git.exitCode === 0 ? git.stdout.toString().trim() : null;
const status = Bun.spawnSync(
	["git", "status", "--porcelain", "--", ...sourceFiles],
	{ cwd: root },
);
// Unknown (null) when git cannot tell, never a silent "clean".
const dirty =
	status.exitCode === 0 ? status.stdout.toString().trim().length > 0 : null;

run(["bun", "run", "build"]);

// Only dist/ and package metadata may ship (plan §7: no data, bench, tests, secrets).
const listing = run(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"]);
const packed = [...listing.matchAll(/^packed\s+\S+\s+(\S+)$/gm)].map(
	(m) => m[1] ?? "",
);
const allowed = (path: string) =>
	path === "package.json" ||
	(path.startsWith("dist/") &&
		(path.endsWith(".js") || path.endsWith(".d.ts")));
const unexpected = packed.filter((p) => !allowed(p));
if (packed.length === 0)
	throw new Error(`could not read the pack listing:\n${listing}`);
if (unexpected.length)
	throw new Error(`unexpected files would ship: ${unexpected.join(", ")}`);
if (!packed.includes("dist/index.js") || !packed.includes("dist/index.d.ts"))
	throw new Error("dist/index.js and dist/index.d.ts must ship");
console.log(`pack contents ok (${packed.length} files): ${packed.join(", ")}`);
if (dryRun) process.exit(0);

const SMOKE = `declare const console: { log(message: string): void };
import { checkDefinition, createCatalogView, isAdoptable, type ComponentRecord } from "${pkg.name}";
const card = (entry: string): ComponentRecord => ({
	card: { entry, bundle: entry, title: entry, summary: "", useWhen: [], avoidWhen: [], output: { schemaRef: null, origin: "missing" }, effects: [], mayAskUser: false },
	execution: "command", enabled: true, support: "ready", reasons: [],
	evidence: { toolchainRevisionId: entry + "@1", definitionHash: null, packageRevisionId: null, bindingRevisionId: null, bindingDigest: null, adapterRef: null, bundleSource: null, toolRevisionIds: [], inputSchemaRefs: [], outputSchemaRef: null, inputOrigin: "missing" },
});
const view = createCatalogView([card("a")], { version: "v", offer: () => true });
const result = checkDefinition({ request: "r", steps: [{ id: "s", bundle: "a", task: "t", from: ["request"], result: "x" }], output: { from: ["s"], deliver: "d" } }, view);
if (!result.ok || result.plan.steps[0]?.entry !== "a") throw new Error("checkDefinition failed in the consumer");
if (isAdoptable({ state: "failed", summary: "", references: [], modelCalls: 0 })) throw new Error("isAdoptable");
console.log("consumer smoke ok");
`;
/** The consumer compiles like Eumenes (ES2022, Bundler) with no Bun/DOM types. */
const CONSUMER_TSCONFIG = {
	compilerOptions: {
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "Bundler",
		lib: ["ES2022"],
		strict: true,
		noEmit: true,
		types: [],
	},
	include: ["smoke.ts"],
};

const artifacts = join(root, "artifacts");
const name = `${pkg.name}-${pkg.version}-${sourceDigest.slice(0, 12)}`;
const artifact = `${name}.tgz`;
/** One directory per artifact, laid out like Eumenes' `vendor/<package>/` (tgz, .sha256, manifest.json). */
const target = join(artifacts, name);
if (existsSync(target))
	throw new Error(
		`${relative(root, target)} exists; bump the version instead of replacing an artifact`,
	);

// Pack into a staging directory; only a tarball that passed every check reaches artifacts/.
const staging = mkdtempSync(join(tmpdir(), "eumenes-pipeline-pack-"));
const consumer = mkdtempSync(join(tmpdir(), "eumenes-pipeline-consumer-"));
let digest: string;
let bytes: Buffer;
try {
	run(["bun", "pm", "pack", "--ignore-scripts", "--destination", staging]);
	const produced = readdirSync(staging).filter((f) => f.endsWith(".tgz"));
	if (produced.length !== 1 || !produced[0])
		throw new Error(`expected one tarball, got ${produced.join(", ")}`);
	const staged = join(staging, artifact);
	renameSync(join(staging, produced[0]), staged);
	bytes = readFileSync(staged);
	digest = sha256(bytes);

	// The tarball itself, not only the dry-run listing, must hold nothing but the allowed files.
	const entries = run(["tar", "-tzf", staged])
		.split("\n")
		.filter((line) => line && !line.endsWith("/"))
		.map((line) => line.replace(/^package\//, ""));
	const stray = entries.filter((entry) => !allowed(entry));
	if (stray.length || entries.length !== packed.length)
		throw new Error(
			`tarball contents differ from the checked listing: ${stray.join(", ") || `${entries.length} vs ${packed.length} files`}`,
		);

	// Consumer check: an empty project outside this repo installs the tarball and uses the API.
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({
			name: "consumer",
			private: true,
			type: "module",
			dependencies: { [pkg.name]: `file:${staged}` },
		}),
	);
	writeFileSync(join(consumer, "smoke.ts"), SMOKE);
	writeFileSync(
		join(consumer, "tsconfig.json"),
		JSON.stringify(CONSUMER_TSCONFIG),
	);
	run(["bun", "install", "--ignore-scripts"], consumer);
	run([join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json"], consumer);
	const out = run(["bun", "smoke.ts"], consumer);
	if (!out.includes("consumer smoke ok"))
		throw new Error(`consumer smoke output: ${out}`);

	const manifest = {
		package: pkg.name,
		version: pkg.version,
		artifact,
		sha256: digest,
		sizeBytes: bytes.length,
		sourceDigest,
		sourceFiles: sourceFiles.length,
		gitSha,
		dirty,
		builtAt: new Date().toISOString(),
		verification: {
			packContents: "passed",
			tarballContents: "passed",
			freshConsumerInstall: "passed",
			consumerTypecheck: "passed",
		},
	};
	// Exclusive creation everywhere: an existing directory or file is never replaced.
	mkdirSync(artifacts, { recursive: true });
	mkdirSync(target);
	copyFileSync(staged, join(target, artifact), constants.COPYFILE_EXCL);
	writeFileSync(
		join(target, `${artifact}.sha256`),
		`${digest}  ${artifact}\n`,
		{
			flag: "wx",
		},
	);
	writeFileSync(
		join(target, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
		{ flag: "wx" },
	);
} finally {
	rmSync(staging, { recursive: true, force: true });
	rmSync(consumer, { recursive: true, force: true });
}
console.log(`${relative(root, join(target, artifact))} sha256 ${digest}`);
