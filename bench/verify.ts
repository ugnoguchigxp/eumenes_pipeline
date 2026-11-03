/**
 * Offline wiring verification (plan §10 `bench:verify`): definitions, catalog resolution, mock host,
 * driver rules, contract synthesis and the reach guard, with no model and no real tool.
 * Every check is recorded as a trial in the work database.
 */
import { checkDefinition, type ExecutionPlan } from "../src/check.ts";
import type { StepExecution } from "../src/contracts/execution.ts";
import { loadBenchCatalog, sha256, type BenchCatalog } from "./catalog/load.ts";
import { INVALID, VALID } from "./fixtures/verify-definitions.ts";
import { runPlan, type RunOutcome } from "./mock/driver.ts";
import { guardInstalled, reachAttemptCount } from "./mock/guard.ts";
import {
	MockDefect,
	MockHost,
	type ArgumentsPolicy,
	type MockScenario,
} from "./mock/host.ts";
import { openWorkDb, type WorkDb } from "./store/work-db.ts";

export type VerifyCheck = { id: string; ok: boolean; detail: string };
export type VerifyReport = {
	runId: string;
	ok: boolean;
	checks: VerifyCheck[];
	catalogVersion: string;
};

const SEED = "bench-verify-v1";
/** Enough seeds to reach every union branch of the current contracts. */
const SWEEP_SEEDS = Array.from({ length: 12 }, (_, i) => `s${i}`);

type Ctx = {
	catalog: BenchCatalog;
	work: WorkDb;
	runId: string;
	checks: VerifyCheck[];
};

/** Open a trial, run `body`, record its verdict as the trial's outcome. */
async function trial(
	ctx: Ctx,
	caseId: string,
	condition: string,
	body: (trialId: string) => Promise<{ ok: boolean; detail: string }>,
) {
	const trialId = ctx.work.startTrial({
		runId: ctx.runId,
		caseId,
		condition,
		attempt: 1,
		phase: "verify",
	});
	let verdict: { ok: boolean; detail: string };
	try {
		verdict = await body(trialId);
	} catch (error) {
		verdict = { ok: false, detail: `threw: ${String(error)}` };
	}
	ctx.checks.push({ id: `${caseId}/${condition}`, ...verdict });
	ctx.work.finishTrial(trialId, {
		status: verdict.ok ? "completed" : "failed",
		outputText: verdict.detail,
	});
}

export async function runVerify(
	options: { dbPath?: string } = {},
): Promise<VerifyReport> {
	if (!guardInstalled())
		throw new Error("bench:verify must run with the reach guard installed");
	// Attempts are never discarded: everything from here on counts, minus the one deliberate probe.
	const baseline = reachAttemptCount();
	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	const work = openWorkDb(options.dbPath);
	const runId = work.startRun({
		kind: "verify",
		config: { seed: SEED, policy: catalog.policy },
		inputs: {
			snapshotSha256: catalog.snapshot.sha256,
			contractsSha256: catalog.contracts.contractsSha256,
			fixturesSha256: catalog.contracts.fixturesSha256,
			catalogVersion: catalog.view.version,
		},
	});
	const ctx: Ctx = { catalog, work, runId, checks: [] };
	let finished = false;
	try {
		await trial(ctx, "guard", "none-before-run", async () => ({
			ok: baseline === 0,
			detail: `${baseline} reach attempts before bench:verify started`,
		}));
		const probes = await guardWorks(ctx);
		for (const fixture of INVALID)
			await trial(ctx, fixture.id, "reject", async (trialId) => {
				const result = checkDefinition(fixture.definition, catalog.view);
				work.recordChecks(trialId, result.issues);
				const codes = result.issues
					.filter((i) => i.severity === "error")
					.map((i) => i.code);
				return {
					ok: !result.ok && codes.includes(fixture.expect),
					detail: `expected ${fixture.expect}; got ${result.ok ? "ok" : codes.join(",")}`,
				};
			});
		for (const fixture of VALID) {
			const result = checkDefinition(fixture.definition, catalog.view);
			await trial(ctx, fixture.id, "accept", async (trialId) => {
				work.recordChecks(trialId, result.issues);
				return result.ok
					? { ok: true, detail: `${result.plan.steps.length} steps` }
					: {
							ok: false,
							detail: result.issues
								.map((i) => `${i.code}@${i.path}`)
								.join(", "),
						};
			});
			if (result.ok) await hostScenarios(ctx, fixture.id, result.plan);
		}
		await synthesisSweep(ctx);
		await trial(ctx, "guard", "zero-reach", async () => {
			const reached = reachAttemptCount() - baseline - probes;
			return { ok: reached === 0, detail: `${reached} reach attempts` };
		});
		finished = true;
	} finally {
		// An exception outside a trial is a failed run, whatever the checks so far said.
		work.finishRun(
			runId,
			finished && ctx.checks.every((c) => c.ok) ? "completed" : "failed",
		);
		work.close();
		catalog.close();
	}
	return {
		runId,
		ok: ctx.checks.every((c) => c.ok),
		checks: ctx.checks,
		catalogVersion: catalog.view.version,
	};
}

/** One deliberate network attempt must be blocked and counted. Returns how many probes it made. */
async function guardWorks(ctx: Ctx): Promise<number> {
	await trial(ctx, "guard", "fetch-blocked", async () => {
		const before = reachAttemptCount();
		let blocked = false;
		try {
			await fetch("https://example.invalid/should-not-leave");
		} catch {
			blocked = true;
		}
		const attempts = reachAttemptCount() - before;
		return {
			ok: blocked && attempts === 1,
			detail: `blocked=${blocked}, attempts=${attempts}`,
		};
	});
	return 1;
}

/** Every offered entry's output (and arguments) can be synthesized and passes its own contract. */
async function synthesisSweep(ctx: Ctx) {
	const { view, contracts } = ctx.catalog;
	for (const card of ctx.catalog.cards)
		await trial(ctx, `synth:${card.entry}`, "contracts", async () => {
			const host = new MockHost({ catalog: view, contracts, seed: SEED });
			const record = view.all.get(card.entry);
			for (const seed of SWEEP_SEEDS) {
				const request = `合成値の確認 ${seed}`;
				try {
					await host.executeStep({
						runId: ctx.runId,
						stepId: `synth-${seed}`,
						entry: card.entry,
						revisionId: record?.evidence.toolchainRevisionId ?? "",
						request,
						references: [],
						source: { request, digest: sha256(request) },
						deadline: Date.now() + 60_000,
					});
				} catch (error) {
					return {
						ok: false,
						detail: error instanceof MockDefect ? error.message : String(error),
					};
				}
			}
			return {
				ok: host.calls.every((c) => c.state === "completed"),
				detail: `output ${card.output.schemaRef ?? "summary-only"}${card.arguments ? ", arguments synthesized" : ""}; ${SWEEP_SEEDS.length} seeds`,
			};
		});
}

type RunExtras = {
	now?: () => number;
	deadlineMs?: number;
	argumentsPolicy?: ArgumentsPolicy;
	/** Abort this controller as soon as the first step is called (cancellation while running). */
	abortOnFirstCall?: AbortController;
	/** Runs when the host has produced a step's result, before the driver sees it. */
	afterCall?: (stepId: string) => void;
};

async function hostScenarios(ctx: Ctx, caseId: string, plan: ExecutionPlan) {
	const { view, contracts } = ctx.catalog;
	const execute = (
		trialId: string,
		condition: string,
		scenario: (step: StepExecution) => MockScenario,
		extras: RunExtras = {},
	): Promise<{ outcome: RunOutcome; host: MockHost }> => {
		const host = new MockHost({
			catalog: view,
			contracts,
			seed: SEED,
			scenario,
			...(extras.argumentsPolicy
				? { argumentsPolicy: extras.argumentsPolicy }
				: {}),
			...(extras.now ? { now: extras.now } : {}),
			onCall: (call) => {
				ctx.work.recordMockCall(ctx.runId, trialId, call);
				extras.abortOnFirstCall?.abort();
				extras.afterCall?.(call.stepId);
			},
		});
		return runPlan(plan, host, {
			runId: `${ctx.runId}:${caseId}:${condition}`,
			validateOutput: contracts.validate,
			...(extras.now ? { now: extras.now } : {}),
			...(extras.deadlineMs ? { deadlineMs: extras.deadlineMs } : {}),
			...(extras.abortOnFirstCall
				? { signal: extras.abortOnFirstCall.signal }
				: {}),
		}).then((outcome) => ({ outcome, host }));
	};
	const complete = (): MockScenario => ({ kind: "complete" });
	const at =
		(index: number, scenario: MockScenario) =>
		(step: StepExecution): MockScenario =>
			step.stepId === plan.steps[index]?.stepId ? scenario : complete();
	const scenario = (
		condition: string,
		body: (trialId: string) => Promise<{ ok: boolean; detail: string }>,
	) => trial(ctx, caseId, condition, body);

	await scenario("all-complete", async (trialId) => {
		const { outcome, host } = await execute(trialId, "all-complete", complete);
		return {
			ok:
				outcome.status === "completed" &&
				host.calls.length === plan.steps.length &&
				outcome.delivered?.length === plan.output.from.length,
			detail: `status=${outcome.status}, calls=${host.calls.length}, delivered=${outcome.delivered?.length ?? 0}`,
		};
	});

	await scenario("deterministic", async (trialId) => {
		const a = await execute(trialId, "deterministic", complete);
		const b = await execute(trialId, "deterministic", complete);
		const digests = (h: MockHost) =>
			h.calls.map((c) => c.outputDigest).join(",");
		const same = digests(a.host) === digests(b.host);
		return {
			ok: same,
			detail: `outputs ${same ? "equal" : "differ"} across runs`,
		};
	});

	const stops: Array<[string, MockScenario]> = [
		["fail", { kind: "fail" }],
		["cancel", { kind: "cancel" }],
		["expire", { kind: "expire" }],
		["ask", { kind: "ask", question: "どちらにしますか" }],
		["indeterminate", { kind: "indeterminate" }],
	];
	for (const [name, stop] of stops)
		await scenario(`stop-${name}`, async (trialId) => {
			const { outcome, host } = await execute(trialId, name, at(0, stop));
			return {
				ok:
					outcome.status === "stopped" &&
					outcome.delivered === null &&
					host.calls.length === 1 &&
					outcome.steps.every((s) => !s.adopted),
				detail: `status=${outcome.status}, calls=${host.calls.length}, stoppedAt=${outcome.stoppedAt?.stepId}:${outcome.stoppedAt?.state}`,
			};
		});

	const declared = plan.steps.findIndex((s) => s.output.schemaRef !== null);
	if (declared >= 0)
		for (const [kind, rejection] of [
			["drop-output", "result_missing_output"],
			["wrong-type", "result_contract_violation"],
		] as const)
			await scenario(kind, async (trialId) => {
				const { outcome, host } = await execute(
					trialId,
					kind,
					at(declared, { kind }),
				);
				const step = outcome.steps[declared];
				return {
					ok:
						outcome.status === "stopped" &&
						step?.adopted === false &&
						step.rejection === rejection &&
						host.calls.length === declared + 1,
					detail: `rejection=${step?.rejection ?? "none"}, calls=${host.calls.length}`,
				};
			});

	await scenario("cancel-midway", async (trialId) => {
		const controller = new AbortController();
		const { outcome, host } = await execute(
			trialId,
			"cancel-midway",
			complete,
			{
				abortOnFirstCall: controller,
			},
		);
		return {
			ok:
				outcome.status === "cancelled" &&
				host.calls.length === 1 &&
				outcome.steps[0]?.adopted === false &&
				outcome.delivered === null,
			detail: `status=${outcome.status}, calls=${host.calls.length}, rejection=${outcome.steps[0]?.rejection ?? "none"}`,
		};
	});

	await scenario("after-deadline", async (trialId) => {
		const last = plan.steps.length - 1;
		let clock = 1_000_000;
		const { outcome } = await execute(trialId, "after-deadline", complete, {
			now: () => clock,
			deadlineMs: 5_000,
			// The clock passes the deadline while the last step runs: its result arrives too late.
			afterCall: (stepId) => {
				if (stepId === plan.steps[last]?.stepId) clock += 10_000;
			},
		});
		const final = outcome.steps[last];
		return {
			ok:
				outcome.status === "stopped" &&
				final?.adopted === false &&
				final.rejection === "after_deadline" &&
				outcome.delivered === null,
			detail: `rejection=${final?.rejection ?? "none"}`,
		};
	});

	const instant = plan.steps.findIndex((s) => s.execution === "instant");
	if (instant >= 0)
		await scenario("arguments-required", async (trialId) => {
			const { outcome } = await execute(
				trialId,
				"arguments-required",
				complete,
				{
					argumentsPolicy: "required",
				},
			);
			const step = outcome.steps[instant];
			return {
				ok:
					step?.result.state === "failed" &&
					step.result.code === "missing_arguments",
				detail: `state=${step?.result.state}, code=${step?.result.code}`,
			};
		});
}
