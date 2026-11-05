/**
 * Offline inference replay. Legacy agent-model files and API-derived files use the same
 * InferencePort. API records require a matching provenance sidecar and output digest.
 * Generation happens outside this adapter; replay never makes a model call.
 *
 * Rules:
 * - A recording is keyed by the digest of the exact inference request. A recording whose
 *   digest does not match the request is never used; a request with
 *   no recording is an explicit error, never a guessed answer.
 * - Legacy usage stays null and its model stays agent-model. Verified API files retain the
 *   actual provider model/usage and generation duration in their sidecar. Complete() returns
 *   durationMs=0 for replay; this is never substituted for actual API generation time.
 * - The adapter reads recording files only. It never reads cases or gold: a recording directory
 *   holds model outputs, keyed by prompt digest, nothing else.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/**
 * Purpose of the triage calls (`bench/format/triage.ts`): one pre-pass call per case
 * that judges only whether the request's information is sufficient, whose conclusion
 * the composing prompt then carries. Triage recordings live in their own directory,
 * never mixed with compose ones.
 */
export const TRIAGE_PURPOSE = "triage";

/**
 * Purpose of the enumeration calls (`bench/format/enumerate.ts`): stage A of the
 * staged-generation condition — one pre-pass call per case that lists only the
 * work items the request asks for, whose ids the composing prompt then carries.
 * Enumeration recordings live in their own directory, never mixed with compose
 * or triage ones.
 */
export const ENUM_PURPOSE = "enumerate";

export const recordingFile = z.strictObject({
	promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
	output: z.string(),
	evidence: z.literal("api").optional(),
});
export type RecordingFile = z.infer<typeof recordingFile>;

const usageSchema = z.strictObject({
	inputTokens: z.number().int().nonnegative().nullable(),
	cachedTokens: z.number().int().nonnegative().nullable(),
	outputTokens: z.number().int().nonnegative().nullable(),
	reasoningTokens: z.number().int().nonnegative().nullable(),
	calls: z.number().int().nonnegative().nullable(),
});
export const apiRecordingSource = z.strictObject({
	version: z.literal(1),
	evidence: z.literal("api"),
	runId: z.string(),
	trialId: z.string(),
	provider: z.enum(["anthropic", "openai"]),
	model: z.string(),
	usage: usageSchema,
	durationMs: z.number().nonnegative(),
	promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
	outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
	requestId: z.string().nullable(),
	/** Undefined is legacy/unknown; null explicitly means no forced schema. */
	outputSchemaDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.nullable()
		.optional(),
});
export type ApiRecordingSource = z.infer<typeof apiRecordingSource>;

/** The digest a recording is keyed by: the whole model-visible request, nothing else. */
export const inferenceDigest = (
	request: Pick<
		InferenceRequest,
		"purpose" | "system" | "prompt" | "outputSchema"
	>,
): string =>
	sha256(
		canonicalJson({
			purpose: request.purpose,
			system: request.system ?? null,
			prompt: request.prompt,
			...(request.outputSchema !== undefined
				? { outputSchema: request.outputSchema }
				: {}),
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
	readonly #sources: ReadonlyMap<string, ApiRecordingSource>;

	constructor(
		recordings: Iterable<RecordingFile>,
		sources: ReadonlyMap<string, ApiRecordingSource> = new Map(),
	) {
		this.#sources = sources;
		for (const recording of recordings) {
			if (recording.evidence === "api" && !sources.has(recording.promptDigest))
				throw new Error("API recording provenance missing");
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
		provenance: Map<string, ApiRecordingSource>;
	} {
		const files = new Map<string, RecordingFile>();
		const provenance = new Map<string, ApiRecordingSource>();
		const sources = new Map<string, ApiRecordingSource>();
		const apiDigests = new Set<string>();
		const evidenceDir = join(dirname(dir), "api-evidence");
		if (existsSync(evidenceDir))
			for (const run of readdirSync(evidenceDir, { withFileTypes: true })) {
				if (!run.isDirectory()) continue;
				for (const name of readdirSync(join(evidenceDir, run.name)).filter(
					(name) => name.endsWith(".json") && name !== "report.json",
				)) {
					const evidence = JSON.parse(
						readFileSync(join(evidenceDir, run.name, name), "utf8"),
					) as { promptDigest?: unknown };
					if (typeof evidence.promptDigest === "string")
						apiDigests.add(evidence.promptDigest);
				}
			}
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
				const sourcePath = join(
					dirname(dir),
					"api-provenance",
					basename(dir),
					name,
				);
				if (existsSync(sourcePath)) {
					const source = apiRecordingSource.parse(
						JSON.parse(readFileSync(sourcePath, "utf8")),
					);
					if (
						source.promptDigest !== parsed.data.promptDigest ||
						source.outputDigest !== sha256(parsed.data.output)
					)
						throw new Error(`API recording provenance mismatch: ${name}`);
					sources.set(source.promptDigest, source);
					provenance.set(name, source);
				} else if (
					parsed.data.evidence === "api" ||
					apiDigests.has(parsed.data.promptDigest)
				) {
					throw new Error(`API recording provenance missing: ${name}`);
				}
			}
		}
		return {
			inference: new RecordedInference(files.values(), sources),
			files,
			provenance,
		};
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
		const source = this.#sources.get(digest);
		const schemaDigest =
			request.outputSchema === undefined
				? null
				: sha256(canonicalJson(request.outputSchema));
		if (source && source.outputSchemaDigest !== schemaDigest)
			return {
				ok: false,
				error:
					"API recording schema identity is missing or mismatched; use its source snapshot or a verified metadata migration",
				model: source.model,
				usage: noUsage(),
				durationMs: 0,
			};
		return {
			ok: true,
			text: output,
			model: this.#sources.get(digest)?.model ?? AGENT_MODEL,
			usage: this.#sources.get(digest)?.usage ?? noUsage(),
			durationMs: 0,
		};
	}
}
