/**
 * Snapshot the composing instructions Eumenes actually uses for a pipeline plan, so the bench can
 * measure the shipped prompt instead of its own (improvement design I1, 2026-11-06).
 *
 * Read-only: it reads the data-driven bundle file and `git` metadata of `../eumenes`. It opens no
 * database, starts no server and writes nothing inside Eumenes.
 *
 *   bun scripts/extract-eumenes-prompt.ts [--eumenes ../eumenes] [--out <json>]
 *
 * The instructions are rebuilt the way Eumenes builds them for a pipeline toolchain
 * (`capabilities` `toolchainSetInTransaction` → `task-execution-port`): the package's profile body
 * and its required skill bodies, each trimmed, joined by a blank line. The output carries no
 * timestamp, so re-extracting unchanged sources gives the same bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		eumenes: { type: "string", default: "../eumenes" },
		out: {
			type: "string",
			default: "data/contracts/eumenes-compose-prompt.json",
		},
	},
});
const BUNDLE =
	"api/domains/capabilities/bundles/pipeline-execution.bundle.json";
const TOOLCHAIN = "pipeline.execute";
const root = resolve(values.eumenes);
const bundleText = readFileSync(join(root, BUNDLE), "utf8");
const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

type Definition = {
	kind: string;
	id: string;
	revision: number;
	body?: string;
	packageRevisionId?: string;
	bindingRevisionId?: string;
	profileRevisionId?: string;
	requiredSkillRevisionIds?: string[];
};
const bundle = JSON.parse(bundleText) as {
	bundleId: string;
	definitions: Definition[];
	bindings: Array<{ id: string; revision: number; contractVersion?: string }>;
};
const revisionId = (d: { kind: string; id: string; revision: number }) =>
	`${d.kind}:${d.id}@${d.revision}`;
const byRevision = new Map(bundle.definitions.map((d) => [revisionId(d), d]));
const toolchain = bundle.definitions.find(
	(d) => d.kind === "toolchain" && d.id === TOOLCHAIN,
);
if (!toolchain?.packageRevisionId)
	throw new Error(`${BUNDLE} has no toolchain ${TOOLCHAIN} with a package`);
const pack = byRevision.get(toolchain.packageRevisionId);
const profile = byRevision.get(pack?.profileRevisionId ?? "")?.body?.trim();
const skills = (pack?.requiredSkillRevisionIds ?? []).map((id) =>
	byRevision.get(id)?.body?.trim(),
);
if (!profile || skills.length === 0 || skills.some((b) => !b))
	throw new Error(`${BUNDLE}: profile or skill body missing`);
const binding = bundle.bindings.find(
	(b) => `binding:${b.id}@${b.revision}` === toolchain.bindingRevisionId,
);
const instructions = [profile, ...(skills as string[])].join("\n\n");

const git = (args: string[]) => {
	const r = Bun.spawnSync(["git", "-C", root, ...args]);
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const dirty = git(["status", "--porcelain", "--", BUNDLE]);
/**
 * Host code the bench mirrors by hand (`bench/format/host-prompt.ts`): the card mapping and the
 * user-message shape. Their committed digests are recorded so a re-extraction shows drift; a
 * working-tree change is recorded, not hidden.
 */
const MIRRORED = [
	"api/application/pipelines/component-catalog.ts",
	"api/domains/agent-runtime/service/execution-compose.ts",
];
const mirrored = MIRRORED.map((path) => {
	const committed = git(["show", `HEAD:${path}`]);
	const status = git(["status", "--porcelain", "--", path]);
	return {
		path,
		headSha256: committed === null ? null : sha256(committed),
		dirty: status === null ? null : status.length > 0,
	};
});
const snapshot = {
	formatVersion: 1,
	source: {
		repository: relative(process.cwd(), root),
		gitCommit: git(["rev-parse", "HEAD"]),
		bundleFile: BUNDLE,
		bundleSha256: sha256(bundleText),
		bundleDirty: dirty === null ? null : dirty.length > 0,
		bundleId: bundle.bundleId,
		toolchainRevisionId: revisionId(toolchain),
		packageRevisionId: toolchain.packageRevisionId,
		profileRevisionId: pack!.profileRevisionId,
		skillRevisionIds: pack!.requiredSkillRevisionIds,
		bindingRevisionId: toolchain.bindingRevisionId ?? null,
		contractVersion: binding?.contractVersion ?? null,
		mirrored,
	},
	/** How Eumenes builds the user message around these instructions (execution-compose). */
	userMessage:
		"JSON.stringify({ request, providedMaterials: [{ref,label,kind,preview}], answers, cards }) with cards mapped by application/pipelines/component-catalog",
	instructions,
	instructionsSha256: sha256(instructions),
};
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(snapshot, null, "\t")}\n`);
console.log(
	`wrote ${relative(process.cwd(), out)} (instructions ${snapshot.instructionsSha256.slice(0, 12)}, eumenes ${snapshot.source.gitCommit?.slice(0, 8)}, dirty ${snapshot.source.bundleDirty})`,
);
