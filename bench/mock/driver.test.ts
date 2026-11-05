import { describe, expect, test } from "bun:test";
import type { ExecutionPlan, PlannedStep } from "../../src/check.ts";
import type {
	StepExecution,
	StepResult,
} from "../../src/contracts/execution.ts";
import type { PipelineHost } from "../../src/ports.ts";
import { requestReference, runPlan } from "./driver.ts";

const planned = (
	stepId: string,
	from: string[],
	schemaRef: string | null = null,
): PlannedStep => ({
	stepId,
	entry: `${stepId}.entry`,
	bundle: null,
	revisionId: `toolchain:${stepId}@1`,
	execution: "command",
	task: `${stepId} task`,
	from,
	expectedResult: "result",
	output: { schemaRef, origin: schemaRef ? "eumenes-code" : "missing" },
});

const plan = (steps: PlannedStep[], outputFrom: string[]): ExecutionPlan => ({
	request: "依頼",
	steps,
	output: { from: outputFrom, deliver: "提示" },
	catalogVersion: "v",
});

/** A host scripted per step id; records what it was asked. */
class FakeHost implements PipelineHost {
	readonly seen: StepExecution[] = [];
	constructor(
		private readonly answer: (step: StepExecution) => Partial<StepResult>,
		private readonly onExecute?: () => void,
	) {}
	async executeStep(step: StepExecution): Promise<StepResult> {
		this.seen.push(step);
		this.onExecute?.();
		return {
			state: "completed",
			summary: `${step.stepId} done`,
			references: [
				{
					ref: `result:${step.stepId}`,
					owner: "fake",
					id: step.stepId,
					revision: "1",
					digest: `d-${step.stepId}`,
					label: step.stepId,
					kind: "result",
					preview: "",
				},
			],
			modelCalls: 0,
			...this.answer(step),
		};
	}
}

const alwaysValid = () => ({ ok: true as const, value: null });

describe("runPlan", () => {
	test("does not dispatch even the first step after an already expired deadline", async () => {
		const host = new FakeHost(() => ({}));
		const outcome = await runPlan(
			plan([planned("a", ["request"])], ["a"]),
			host,
			{
				runId: "expired",
				validateOutput: alwaysValid,
				now: () => 100,
				deadlineMs: -1,
			},
		);
		expect(host.seen).toHaveLength(0);
		expect(outcome.status).toBe("stopped");
		expect(outcome.stoppedAt?.code).toBe("deadline_before_dispatch");
		expect(outcome.delivered).toBeNull();
	});
	test("hands each step only the request and the earlier results it names", async () => {
		const host = new FakeHost(() => ({}));
		const outcome = await runPlan(
			plan(
				[
					planned("a", ["request"]),
					planned("b", ["a"]),
					planned("c", ["request", "a", "b"]),
				],
				["b", "c"],
			),
			host,
			{ runId: "r", validateOutput: alwaysValid },
		);
		expect(outcome.status).toBe("completed");
		expect(host.seen.map((s) => s.references.map((r) => r.ref))).toEqual([
			["request"],
			["result:a"],
			["request", "result:a", "result:b"],
		]);
		expect(host.seen[0]?.references[0]).toEqual(requestReference("依頼"));
		expect(host.seen.every((s) => s.source.request === "依頼")).toBe(true);
		expect(outcome.delivered?.map((d) => d.from)).toEqual(["b", "c"]);
	});

	test.each([
		"failed",
		"cancelled",
		"expired",
		"waiting_input",
		"indeterminate",
		"running",
		"handoff",
	] as const)("stops at a %s step and runs nothing after it", async (state) => {
		const host = new FakeHost((step) => (step.stepId === "a" ? { state } : {}));
		const outcome = await runPlan(
			plan([planned("a", ["request"]), planned("b", ["a"])], ["b"]),
			host,
			{
				runId: "r",
				validateOutput: alwaysValid,
			},
		);
		expect(outcome.status).toBe("stopped");
		expect(outcome.stoppedAt).toEqual({ stepId: "a", state, code: null });
		expect(host.seen).toHaveLength(1);
		expect(outcome.delivered).toBeNull();
	});

	test("partial success is not reported as completion", async () => {
		const host = new FakeHost((step) =>
			step.stepId === "b" ? { state: "failed", code: "boom" } : {},
		);
		const outcome = await runPlan(
			plan(
				[planned("a", ["request"]), planned("b", ["a"]), planned("c", ["b"])],
				["c"],
			),
			host,
			{ runId: "r", validateOutput: alwaysValid },
		);
		// Step `a` was adopted, yet the run as a whole is stopped, delivers nothing,
		// and the step after the failure never ran.
		expect(outcome.steps[0]?.adopted).toBe(true);
		expect(outcome.status).toBe("stopped");
		expect(outcome.stoppedAt).toEqual({
			stepId: "b",
			state: "failed",
			code: "boom",
		});
		expect(outcome.delivered).toBeNull();
		expect(host.seen.map((s) => s.stepId)).toEqual(["a", "b"]);
	});

	test("a completed step without its declared output is not handed on", async () => {
		const host = new FakeHost(() => ({}));
		const outcome = await runPlan(
			plan([planned("a", ["request"], "domain:x@1")], ["a"]),
			host,
			{
				runId: "r",
				validateOutput: alwaysValid,
			},
		);
		expect(outcome.steps[0]).toMatchObject({
			adopted: false,
			rejection: "result_missing_output",
		});
	});

	test("a completed output that breaks its contract is not handed on", async () => {
		const host = new FakeHost(() => ({ output: { wrong: true } }));
		const outcome = await runPlan(
			plan([planned("a", ["request"], "domain:x@1")], ["a"]),
			host,
			{
				runId: "r",
				validateOutput: () => ({
					ok: false,
					issues: [{ path: "", message: "bad" }],
				}),
			},
		);
		expect(outcome.steps[0]).toMatchObject({
			adopted: false,
			rejection: "result_contract_violation",
		});
		expect(outcome.stoppedAt?.code).toBe("result_contract_violation");
	});

	test("a result arriving after cancellation is not adopted", async () => {
		const controller = new AbortController();
		const host = new FakeHost(
			() => ({}),
			() => controller.abort(),
		);
		const outcome = await runPlan(
			plan([planned("a", ["request"]), planned("b", ["a"])], ["b"]),
			host,
			{
				runId: "r",
				validateOutput: alwaysValid,
				signal: controller.signal,
			},
		);
		expect(outcome.status).toBe("cancelled");
		expect(outcome.steps[0]).toMatchObject({
			adopted: false,
			rejection: "after_cancel",
		});
		expect(host.seen).toHaveLength(1);
	});

	test("a result arriving after the deadline is not adopted", async () => {
		let clock = 0;
		const host = new FakeHost(
			() => ({}),
			() => {
				clock += 100;
			},
		);
		const outcome = await runPlan(
			plan([planned("a", ["request"])], ["a"]),
			host,
			{
				runId: "r",
				validateOutput: alwaysValid,
				now: () => clock,
				deadlineMs: 50,
			},
		);
		expect(outcome.steps[0]).toMatchObject({
			adopted: false,
			rejection: "after_deadline",
		});
		expect(outcome.delivered).toBeNull();
	});

	test("nothing runs when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const host = new FakeHost(() => ({}));
		const outcome = await runPlan(
			plan([planned("a", ["request"])], ["a"]),
			host,
			{
				runId: "r",
				validateOutput: alwaysValid,
				signal: controller.signal,
			},
		);
		expect(outcome.status).toBe("cancelled");
		expect(host.seen).toHaveLength(0);
	});
});
