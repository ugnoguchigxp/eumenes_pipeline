/**
 * bench:selection — run candidate selection over the seed cases and record it (plan §10).
 * Each case's request is selected against the full offered card set; the trial's output is
 * the ranked candidates WITH their provenance, so a later report can always name the network
 * and model hash behind a number, and never has to mix networks.
 *
 * This runner measures nothing by itself: with the stub transport its output is wiring
 * evidence, and with a live transport it is a Router-path record whose scores must not be
 * called unseen-data accuracy until the training-overlap check exists (plan §9).
 */
import { canonicalJson, loadBenchCatalog } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import { captureCases } from "../cases/provenance.ts";
import { openWorkDb, DEFAULT_WORK_DB } from "../store/work-db.ts";
import type { SelectionPort, SelectionResult } from "./port.ts";

export type SelectionRunReport = {
	runId: string;
	results: Array<{ caseId: string; result: SelectionResult }>;
};

export async function runSelection(
	selection: SelectionPort,
	options: {
		transportLabel: string;
		dbPath?: string;
		casesDir?: string;
		caseIds?: readonly string[];
	} = { transportLabel: "unknown" },
): Promise<SelectionRunReport> {
	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	const allCases = loadCases(options.casesDir);
	const cases = options.caseIds
		? allCases.filter((c) => options.caseIds?.includes(c.id))
		: allCases;
	if (options.caseIds && cases.length !== options.caseIds.length)
		throw new Error(
			`unknown case id(s): ${options.caseIds.filter((id) => !cases.some((c) => c.id === id)).join(", ")}`,
		);
	const work = openWorkDb(options.dbPath ?? DEFAULT_WORK_DB);
	const runId = work.startRun({
		kind: "selection",
		config: {
			transport: options.transportLabel,
			policy: catalog.policy,
			cards: catalog.cards.length,
		},
		inputs: {
			snapshotSha256: catalog.snapshot.sha256,
			contractsSha256: catalog.contracts.contractsSha256,
			fixturesSha256: catalog.contracts.fixturesSha256,
			catalogVersion: catalog.view.version,
			caseIds: cases.map((c) => c.id),
			caseSnapshot: captureCases(cases, options.casesDir),
		},
	});
	const results: SelectionRunReport["results"] = [];
	let sweepDone = false;
	try {
		for (const evalCase of cases) {
			const trialId = work.startTrial({
				runId,
				caseId: evalCase.id,
				condition: "router-candidates",
				attempt: 1,
				phase: "select",
			});
			try {
				const result = await selection.select(evalCase.request, catalog.cards);
				work.finishTrial(trialId, {
					status: "completed",
					outputText: canonicalJson(result),
				});
				results.push({ caseId: evalCase.id, result });
			} catch (error) {
				work.finishTrial(trialId, {
					status: "failed",
					error: String(error),
				});
				throw error;
			}
		}
		sweepDone = true;
	} finally {
		work.finishRun(runId, sweepDone ? "completed" : "failed");
		work.close();
		catalog.close();
	}
	return { runId, results };
}
