/**
 * Snapshot the composing instructions Eumenes actually uses for a pipeline plan, so the bench can
 * measure the shipped prompt instead of its own (improvement design I1, 2026-11-06).
 *
 * Read-only: it reads the data-driven bundle file and `git` metadata of `../eumenes`. It opens no
 * database, starts no server and writes nothing inside Eumenes.
 *
 *   bun scripts/extract-eumenes-prompt.ts [--eumenes ../eumenes] [--out <json>]
 *     [--toolchain-revision toolchain:pipeline.execute@N]
 *     [--expected-instructions-sha256 <adopted prompt digest>]
 * Multiple revisions require an explicit selection; neither order nor the highest revision
 * establishes which revision the host has adopted. This script never reads the live registry.
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
import {
	deriveHostPrompt,
	revisionId,
	type PromptBundle,
} from "./eumenes-prompt.ts";

const { values } = parseArgs({
	options: {
		eumenes: { type: "string", default: "../eumenes" },
		"toolchain-revision": { type: "string" },
		"expected-instructions-sha256": { type: "string" },
		out: {
			type: "string",
			default: "data/contracts/eumenes-compose-prompt.json",
		},
	},
});
const BUNDLE =
	"api/domains/capabilities/bundles/pipeline-execution.bundle.json";
const root = resolve(values.eumenes);
const bundleText = readFileSync(join(root, BUNDLE), "utf8");
const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

const bundle = JSON.parse(bundleText) as PromptBundle;
const { toolchain, pack, binding, instructions, instructionsSha256 } =
	deriveHostPrompt(bundle, {
		toolchainRevisionId: values["toolchain-revision"],
		expectedInstructionsSha256: values["expected-instructions-sha256"],
	});

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
		profileRevisionId: pack.profileRevisionId,
		skillRevisionIds: pack.requiredSkillRevisionIds,
		bindingRevisionId: toolchain.bindingRevisionId ?? null,
		contractVersion: binding?.contractVersion ?? null,
		mirrored,
	},
	/** How Eumenes builds the user message around these instructions (execution-compose). */
	userMessage:
		"JSON.stringify({ request, providedMaterials: [{ref,label,kind,preview}], answers, cards }) with cards mapped by application/pipelines/component-catalog",
	instructions,
	instructionsSha256,
};
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(snapshot, null, "\t")}\n`);
console.log(
	`wrote ${relative(process.cwd(), out)} (instructions ${snapshot.instructionsSha256.slice(0, 12)}, eumenes ${snapshot.source.gitCommit?.slice(0, 8)}, dirty ${snapshot.source.bundleDirty})`,
);
