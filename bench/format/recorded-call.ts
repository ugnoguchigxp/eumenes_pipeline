/**
 * One recorded-call lookup: a missing file is written, a digest mismatch is refused,
 * and only a matching recording is replayed. Callers keep their own error wording,
 * request JSON, and what a successful text means.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InferenceRequest, InferenceResult } from "../../src/ports.ts";
import { inferenceDigest, type RecordingFile } from "../infer/recorded.ts";

export type RecordedCall =
	| { state: "missing"; error: string }
	| { state: "digest-mismatch"; error: string }
	| {
			state: "inference-error";
			error: string;
			result: Extract<InferenceResult, { ok: false }>;
	  }
	| { state: "ready"; result: Extract<InferenceResult, { ok: true }> };

export async function resolveRecordedCall(input: {
	files: ReadonlyMap<string, RecordingFile>;
	complete: (request: InferenceRequest) => Promise<InferenceResult>;
	request: InferenceRequest;
	digest: string;
	fileName: string;
	requestsDir: string;
	/** Written as tab-indented JSON when the recording is absent. Key order is kept. */
	missingBody: Record<string, unknown>;
	missingError: string;
	mismatchError: (claimedDigest: string) => string;
}): Promise<RecordedCall> {
	const recording = input.files.get(input.fileName);
	if (!recording) {
		writeFileSync(
			join(input.requestsDir, input.fileName),
			`${JSON.stringify(input.missingBody, null, "\t")}\n`,
		);
		return { state: "missing", error: input.missingError };
	}
	if (recording.promptDigest !== input.digest)
		return {
			state: "digest-mismatch",
			error: input.mismatchError(recording.promptDigest),
		};
	const result = await input.complete(input.request);
	if (!result.ok)
		return { state: "inference-error", error: result.error, result };
	return { state: "ready", result };
}

export type PrePassState =
	"concluded" | "missing" | "digest-mismatch" | "invalid" | "inference-error";

/** A case-level pre-pass (triage, enumeration) resolved before composing starts. */
export type PrePassResolution<TCase extends { id: string }, TConclusion> = {
	evalCase: TCase;
	system: string;
	prompt: string;
	state: PrePassState;
	conclusion?: TConclusion;
	/** The served inference result, when a recording answered the call. */
	result?: InferenceResult;
	error?: string;
};

export async function resolvePrePass<
	TCase extends { id: string },
	TConclusion,
>(input: {
	evalCase: TCase;
	files: ReadonlyMap<string, RecordingFile>;
	complete: (request: InferenceRequest) => Promise<InferenceResult>;
	request: InferenceRequest & { system: string };
	requestsDir: string;
	missingError: (fileName: string) => string;
	/** Wording before "digest mismatch", e.g. "triage recording". */
	mismatchPrefix: string;
	invalidError: string;
	parse: (text: string) => TConclusion | null;
}): Promise<PrePassResolution<TCase, TConclusion>> {
	const digest = inferenceDigest(input.request);
	const fileName = `${input.evalCase.id}.json`;
	const base = {
		evalCase: input.evalCase,
		system: input.request.system,
		prompt: input.request.prompt,
	};
	const call = await resolveRecordedCall({
		files: input.files,
		complete: input.complete,
		request: input.request,
		digest,
		fileName,
		requestsDir: input.requestsDir,
		missingBody: {
			caseId: input.evalCase.id,
			purpose: input.request.purpose,
			system: input.request.system,
			prompt: input.request.prompt,
			promptDigest: digest,
		},
		missingError: input.missingError(fileName),
		mismatchError: (claimed) =>
			`${input.mismatchPrefix} digest mismatch: prompt digest is ${digest}, recording claims ${claimed}; recording refused`,
	});
	if (call.state === "missing" || call.state === "digest-mismatch")
		return { ...base, state: call.state, error: call.error };
	if (call.state === "inference-error")
		return {
			...base,
			state: "inference-error",
			result: call.result,
			error: call.error,
		};
	const conclusion = input.parse(call.result.text);
	if (conclusion)
		return {
			...base,
			state: "concluded",
			conclusion,
			result: call.result,
		};
	return {
		...base,
		state: "invalid",
		result: call.result,
		error: input.invalidError,
	};
}
