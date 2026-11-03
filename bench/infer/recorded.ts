/**
 * Agent-model inference (user's instruction, 2026-11-03): in P0d the composing/judging inference
 * is Muse itself, not a live model and not `muse exec`. Generation happens OUTSIDE this
 * code — an agent reads a request file and writes a recording — and this adapter only replays
 * recordings through the `InferencePort` shape, so a recorded run is reproducible byte for byte.
 *
 * Rules:
 * - A recording is keyed by the digest of the exact inference request (purpose + system +
 *   prompt). A recording whose digest does not match the request is never used; a request with
 *   no recording is an explicit error, never a guessed answer.
 * - Usage is all null: the agent's token counts are not obtainable, and unobtainable values are
 *   never filled with 0 or an estimate (plan §10). `model` is the constant `agent-model`, so
 *   every stored model call carries its evidence kind; results from this port are agent-model
 *   evidence and are never reported as a real model's measurement or acceptance.
 * - The adapter reads recording files only. It never reads cases or gold: a recording directory
 *   holds model outputs, keyed by prompt digest, nothing else.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
	InferencePort,
	InferenceRequest,
	InferenceResult,
	InferenceUsage,
} from "../../src/ports.ts";
import { canonicalJson, sha256 } from "../catalog/load.ts";

/** The `model` value recorded for every call this port serves: the evidence kind, not a model. */
export const AGENT_MODEL = "agent-model";

/** Purpose of the composing calls the format/selection benches record. */
export const COMPOSE_PURPOSE = "compose";

/**
 * Purpose of the repair calls (`bench/format/run.ts`): one follow-up call that receives a
 * failed composing output plus the machine errors it produced and returns a corrected
 * output. Repair recordings live in their own directory, never mixed with compose ones.
 */
export const REPAIR_PURPOSE = "repair";

export const recordingFile = z.strictObject({
	promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
	output: z.string(),
});
export type RecordingFile = z.infer<typeof recordingFile>;

/** The digest a recording is keyed by: the whole model-visible request, nothing else. */
export const inferenceDigest = (
	request: Pick<InferenceRequest, "purpose" | "system" | "prompt">,
): string =>
	sha256(
		canonicalJson({
			purpose: request.purpose,
			system: request.system ?? null,
			prompt: request.prompt,
		}),
	);

const noUsage = (): InferenceUsage => ({
	inputTokens: null,
	cachedTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	calls: null,
});

export class RecordedInference implements InferencePort {
	readonly #byDigest = new Map<string, string>();

	constructor(recordings: Iterable<RecordingFile>) {
		for (const recording of recordings) {
			if (this.#byDigest.has(recording.promptDigest))
				throw new Error(
					`duplicate recording for prompt digest ${recording.promptDigest}`,
				);
			this.#byDigest.set(recording.promptDigest, recording.output);
		}
	}

	/**
	 * Load every `*.json` recording in `dir` (a missing directory is an empty set, not an
	 * error: the runner reports the missing cells itself). Malformed files and duplicate
	 * digests fail loudly — a shrunken or ambiguous recording set must never pass silently.
	 */
	static fromDirectory(dir: string): {
		inference: RecordedInference;
		files: Map<string, RecordingFile>;
	} {
		const files = new Map<string, RecordingFile>();
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)
				.filter((n) => n.endsWith(".json"))
				.sort()) {
				const path = join(dir, name);
				let raw: unknown;
				try {
					raw = JSON.parse(readFileSync(path, "utf8"));
				} catch (error) {
					throw new Error(`${path}: not valid JSON: ${String(error)}`);
				}
				const parsed = recordingFile.safeParse(raw);
				if (!parsed.success)
					throw new Error(
						`${path}: invalid recording: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
					);
				files.set(name, parsed.data);
			}
		}
		return { inference: new RecordedInference(files.values()), files };
	}

	async complete(request: InferenceRequest): Promise<InferenceResult> {
		const digest = inferenceDigest(request);
		const output = this.#byDigest.get(digest);
		if (output === undefined)
			return {
				ok: false,
				error: `no recording for prompt digest ${digest} (purpose "${request.purpose}")`,
				model: AGENT_MODEL,
				usage: noUsage(),
				durationMs: 0,
			};
		return {
			ok: true,
			text: output,
			model: AGENT_MODEL,
			usage: noUsage(),
			durationMs: 0,
		};
	}
}
