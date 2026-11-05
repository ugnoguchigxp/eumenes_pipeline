/** Offline structural cost only; these timings do not represent inference or real tool execution. */
import { checkDefinition } from "../../src/check.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import { openWorkDb } from "../store/work-db.ts";
import { installGuard } from "../mock/guard.ts";

installGuard();
const budget = {
	p95Ms: 5,
	callsPerCell: 1000,
	warmups: 100,
	scope:
		"checkDefinition with the real offered catalog, 1/8 steps, short/maximum task text",
};
const catalog = loadBenchCatalog();
const work = openWorkDb();
const runId = work.startRun({
	kind: "performance",
	config: { budget },
	inputs: { catalogVersion: catalog.view.version },
});
let passed = true;
try {
	for (const steps of [1, 8])
		for (const taskLength of [20, 2000]) {
			const request = "許可された合成データの構造検査";
			const input = {
				request,
				steps: Array.from({ length: steps }, (_, i) => ({
					id: `s${i}`,
					bundle: "compute.python",
					task: "a".repeat(taskLength),
					result: "計算結果",
					from: i ? ["request", `s${i - 1}`] : ["request"],
				})),
				output: { from: [`s${steps - 1}`], deliver: "結果を示す" },
			};
			for (let i = 0; i < budget.warmups; i++)
				checkDefinition(input, catalog.view, { sourceRequest: request });
			const heapBefore = process.memoryUsage().heapUsed;
			const samples: number[] = [];
			for (let i = 0; i < budget.callsPerCell; i++) {
				const start = performance.now();
				const checked = checkDefinition(input, catalog.view, {
					sourceRequest: request,
				});
				samples.push(performance.now() - start);
				if (!checked.ok)
					throw new Error("performance fixture did not pass structure checks");
			}
			samples.sort((a, b) => a - b);
			const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1]!;
			const result = {
				steps,
				taskLength,
				offeredCards: catalog.cards.length,
				samples: samples.length,
				medianMs: samples[Math.floor(samples.length / 2)],
				p95Ms,
				maxMs: samples.at(-1),
				heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
				actualBilledUsd: null,
				apiCalls: 0,
				passed: p95Ms <= budget.p95Ms,
			};
			const trialId = work.startTrial({
				runId,
				caseId: `${steps}-${taskLength}`,
				condition: "structure",
				attempt: 1,
				phase: "measure",
			});
			work.finishTrial(trialId, {
				status: "completed",
				outputText: JSON.stringify(result),
			});
			console.log(JSON.stringify(result));
			passed &&= result.passed;
		}
	work.finishRun(runId, passed ? "completed" : "failed");
	console.log(JSON.stringify({ runId, budget, passed }));
} catch (error) {
	work.finishRun(runId, "failed");
	throw error;
} finally {
	catalog.close();
	work.close();
}
if (!passed) process.exitCode = 1;
