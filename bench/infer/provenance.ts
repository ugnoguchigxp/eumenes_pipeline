/** Verify an API-derived file against its immutable call and exact original request. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../catalog/load.ts";
import {
	inferenceDigest,
	type ApiRecordingSource,
	type RecordingFile,
} from "./recorded.ts";

export function verifyApiRecording(options: {
	db: Database;
	runsRoot: string;
	file: string;
	source: ApiRecordingSource;
	recording: RecordingFile;
	provider: string;
	model: string;
	phase: "compose" | "repair" | "judge";
}) {
	const { db, runsRoot, file, source, recording, provider, model, phase } =
		options;
	const rows = db
		.query<
			{
				config_json: string;
				inputs_json: string;
				kind: string;
				status: string;
				case_id: string;
				phase: string;
				output_text: string | null;
				output_digest: string | null;
				model: string;
				purpose: string;
				ok: number;
				input_tokens: number | null;
				output_tokens: number | null;
				cached_tokens: number | null;
				reasoning_tokens: number | null;
				calls: number | null;
				duration_ms: number;
			},
			[string, string]
		>(
			`SELECT r.config_json,r.inputs_json,r.kind,t.status,t.case_id,t.phase,t.output_text,t.output_digest,m.model,m.purpose,m.ok,m.input_tokens,m.output_tokens,m.cached_tokens,m.reasoning_tokens,m.calls,m.duration_ms FROM runs r JOIN trials t ON t.run_id=r.run_id JOIN model_calls m ON m.trial_id=t.trial_id WHERE r.run_id=? AND t.trial_id=?`,
		)
		.all(source.runId, source.trialId);
	const call = rows.length === 1 ? rows[0] : undefined;
	if (!call) throw new Error("API source has no unique matching work DB call");
	const config = JSON.parse(call.config_json),
		inputs = JSON.parse(call.inputs_json);
	if (
		call.kind !== "api-inference" ||
		call.status !== "completed" ||
		call.ok !== 1 ||
		call.case_id !== file ||
		call.phase !== phase ||
		call.purpose !== phase ||
		config.evidence !== "api" ||
		config.provider !== provider ||
		config.model !== model ||
		config.phase !== phase ||
		call.model !== model ||
		source.provider !== provider ||
		source.model !== model ||
		call.output_text === null ||
		call.output_digest !== source.outputDigest ||
		sha256(recording.output) !== source.outputDigest ||
		recording.promptDigest !== source.promptDigest
	)
		throw new Error("API recording differs from its completed call");
	const usage = {
		inputTokens: call.input_tokens,
		outputTokens: call.output_tokens,
		cachedTokens: call.cached_tokens,
		reasoningTokens: call.reasoning_tokens,
		calls: call.calls,
	};
	if (
		canonicalJson(usage) !== canonicalJson(source.usage) ||
		call.duration_ms !== Math.round(source.durationMs)
	)
		throw new Error("API usage or duration differs from work DB call");
	if (
		typeof config.session !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.session) ||
		!/^[a-z0-9][a-z0-9._-]{0,99}\.json$/.test(file)
	)
		throw new Error("invalid API source path");
	const requestPath = join(
		runsRoot,
		config.session,
		phase === "compose" ? "requests" : `${phase}-requests`,
		file,
	);
	const bytes = readFileSync(requestPath, "utf8"),
		request = JSON.parse(bytes);
	const original = inputs.requests?.find(
		(r: { name: string }) => r.name === file,
	);
	if (
		!original ||
		original.sha256 !== sha256(bytes) ||
		original.promptDigest !== request.promptDigest ||
		request.purpose !== phase ||
		inferenceDigest(request) !== source.promptDigest ||
		source.outputSchemaDigest !==
			(request.outputSchema === undefined
				? null
				: sha256(canonicalJson(request.outputSchema)))
	)
		throw new Error("API source request identity mismatch");
	return { request, requestPath };
}
