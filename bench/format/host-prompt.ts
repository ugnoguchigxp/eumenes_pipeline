/**
 * The composing prompt Eumenes ships (condition `eumenes`, prompt style `eumenes-p0-3`), so the
 * bench measures what the host actually sends rather than its own template (improvement design
 * I1, 2026-11-06).
 *
 * - System: the pipeline bundle's instructions, read from the snapshot that
 *   `scripts/extract-eumenes-prompt.ts` takes of `../eumenes` (digest-checked here).
 * - User: the JSON message of Eumenes' `execution-compose` — request, provided materials, answers
 *   and cards — with each card mapped as `application/pipelines/component-catalog.ts` maps it.
 *
 * Reading (`parseHostOutput`, and the binding in `run.ts`) follows the host too: the strict reader
 * on the raw text without trimming, an explicit `status` (Eumenes parses with the discriminated
 * `authoringOutcome`, so a bare definition is a defect there), and the original request bound
 * before the check. The host's repair message is not reproduced, so this condition takes no repair.
 *
 * Approximations, recorded with every run that uses this style: bench cases carry a material's name
 * and kind but no host reference or content, so a material becomes `{ref: "material:<n>", label:
 * "<name>（<kind>）", kind: "resource", preview: ""}`; `answers` is empty (a bench cell is one
 * composing call, never the follow-up after a question); the cards are the bench catalog's offered
 * cards under the host's mapping, not the live registry's.
 *
 * FAIRNESS (plan §9): built from the case's request and provided materials and the offered cards
 * only. `expected`, acceptable answers and case notes never reach this module.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { CONTRACT_VERSION } from "../../src/contracts/record.ts";
import { parseJsonStrict } from "../../src/internal/strict-json.ts";
import type { EvalCase } from "../cases/cases.ts";
import {
	fail,
	MAX_INPUT_CHARS,
	outcomeFromValue,
	type ParseResult,
} from "../formats/outcome.ts";

/** Revision 1 remains at its historical path for explicit replays. */
export const DEFAULT_HOST_PROMPT =
	"data/contracts/eumenes-compose-prompt-v2.json";

const snapshotSchema = z.object({
	formatVersion: z.literal(1),
	source: z
		.object({
			gitCommit: z.string().nullable(),
			bundleDirty: z.boolean().nullable(),
			contractVersion: z.string().nullable(),
			toolchainRevisionId: z.string().min(1),
		})
		.passthrough(),
	instructions: z.string().min(1),
	instructionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type HostPrompt = {
	instructions: string;
	instructionsSha256: string;
	gitCommit: string | null;
	toolchainRevisionId: string;
	snapshotSha256: string;
	/** Exact source evidence retained in the work DB for portable replay. */
	snapshotText: string;
};

/** Freeze all source evidence, not just the instruction text; paths are not identities. */
export function hostPromptIdentity(host: HostPrompt) {
	return {
		instructionsSha256: host.instructionsSha256,
		gitCommit: host.gitCommit,
		toolchainRevisionId: host.toolchainRevisionId,
		snapshotSha256: host.snapshotSha256,
		inputMode: "bench-catalog-material-labels-no-answers" as const,
	};
}

/** Load the snapshot; a changed text, a dirty source or another contract is a setup error. */
export function loadHostPrompt(
	path = DEFAULT_HOST_PROMPT,
	expectedToolchainRevisionId?: string,
): HostPrompt {
	const raw = readFileSync(path, "utf8");
	const snapshot = snapshotSchema.parse(JSON.parse(raw));
	const digest = createHash("sha256")
		.update(snapshot.instructions)
		.digest("hex");
	if (digest !== snapshot.instructionsSha256)
		throw new Error(`${path}: instructions do not match their recorded digest`);
	if (snapshot.source.bundleDirty !== false)
		throw new Error(
			`${path}: taken from an uncommitted or unknown bundle; re-extract from a clean commit`,
		);
	if (snapshot.source.contractVersion !== CONTRACT_VERSION)
		throw new Error(
			`${path}: host binding contract ${snapshot.source.contractVersion} is not ${CONTRACT_VERSION}`,
		);
	if (
		expectedToolchainRevisionId !== undefined &&
		snapshot.source.toolchainRevisionId !== expectedToolchainRevisionId
	)
		throw new Error(
			`${path}: host toolchain revision differs from requested revision`,
		);
	return {
		instructions: snapshot.instructions,
		instructionsSha256: snapshot.instructionsSha256,
		gitCommit: snapshot.source.gitCommit,
		toolchainRevisionId: snapshot.source.toolchainRevisionId,
		snapshotSha256: createHash("sha256").update(raw).digest("hex"),
		snapshotText: raw,
	};
}

/** The card as Eumenes' component catalog builds it: entry as bundle, no completed-output schema. */
export function eumenesCard(card: ComponentCard): ComponentCard {
	return {
		entry: card.entry,
		bundle: card.entry,
		title: card.title,
		summary: card.summary,
		useWhen: card.useWhen,
		avoidWhen: card.avoidWhen,
		...(card.arguments ? { arguments: card.arguments } : {}),
		output: { schemaRef: null, origin: "missing" },
		effects: ["read", "write"],
		mayAskUser: true,
	};
}

export function buildHostPrompt(input: {
	evalCase: EvalCase;
	cards: readonly ComponentCard[];
	host: HostPrompt;
}): { system: string; prompt: string } {
	const { evalCase } = input;
	return {
		system: input.host.instructions,
		prompt: JSON.stringify({
			request: evalCase.request,
			providedMaterials: evalCase.providedMaterials.map((m, i) => ({
				ref: `material:${i + 1}`,
				label: `${m.name}（${m.kind}）`,
				kind: "resource",
				preview: "",
			})),
			answers: [],
			cards: input.cards.map(eumenesCard),
		}),
	};
}

/** The host's reading of a composing output: strict JSON, untrimmed, with an explicit `status`. */
export function parseHostOutput(text: string): ParseResult {
	if (text.length > MAX_INPUT_CHARS)
		return fail("too_large", `input longer than ${MAX_INPUT_CHARS} characters`);
	const parsed = parseJsonStrict(text);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };
	const value = parsed.value;
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!Object.hasOwn(value, "status")
	)
		return fail(
			"status_required",
			"the host reads only an outcome with an explicit status",
		);
	return outcomeFromValue(value);
}
