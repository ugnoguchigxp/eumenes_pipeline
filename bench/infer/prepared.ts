/** Local preparation manifests bind paid requests to their frozen producer conditions. */
import type { WorkDb } from "../store/work-db.ts";
import { canonicalJson } from "../catalog/load.ts";
import type { EvaluationFreeze } from "../cases/freeze.ts";
export type PreparedApiRequest = {
	phase: "compose" | "repair" | "judge";
	name: string;
	promptDigest: string;
};
export function recordPreparedRequests(
	work: WorkDb,
	input: {
		session: string;
		freezeDigest: string;
		requests: PreparedApiRequest[];
		parentRunId?: string;
	},
) {
	const runId = work.startRun({
		kind: "api-request-preparation",
		config: { session: input.session, freezeDigest: input.freezeDigest },
		inputs: { requests: input.requests },
		parentRunId: input.parentRunId,
	});
	work.finishRun(runId, "completed");
}
export function verifyPreparedRequests(
	work: WorkDb,
	freeze: EvaluationFreeze,
	session: string,
	phase: PreparedApiRequest["phase"],
	requests: readonly { name: string; request: { promptDigest: string } }[],
) {
	const row = work.db
		.query<{ inputs_json: string }, [string, string]>(
			"SELECT inputs_json FROM runs WHERE kind='api-request-preparation' AND status='completed' AND json_extract(config_json,'$.session')=? AND json_extract(config_json,'$.freezeDigest')=? ORDER BY rowid DESC LIMIT 1",
		)
		.get(session, freeze.digest);
	if (!row)
		throw new Error(
			"frozen requests have no preparation manifest; prepare this session with --freeze first",
		);
	const inputs = JSON.parse(row.inputs_json);
	const select = (list: PreparedApiRequest[]) =>
		list
			.filter((r) => r.phase === phase)
			.map((r) => ({ name: r.name, promptDigest: r.promptDigest }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const current = requests.map((r) => ({
		phase,
		name: r.name,
		promptDigest: r.request.promptDigest,
	}));
	if (
		inputs.source?.sha256 !== freeze.sourceSha256 ||
		canonicalJson(select(inputs.requests)) !== canonicalJson(select(current))
	)
		throw new Error("requests differ from frozen preparation");
}
