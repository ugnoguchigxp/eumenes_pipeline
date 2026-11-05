import { describe, expect, test } from "bun:test";
import { apiBudget } from "./api-budget.ts";
import { openWorkDb } from "./work-db.ts";

describe("shared API budget", () => {
	test("unknown responses retain full reservations and settlements release only the unused bound", () => {
		const work = openWorkDb(":memory:");
		try {
			const budget = apiBudget(work.db, "experiment", 2);
			const first = budget.reserve(1.2, { provider: "one" });
			expect(() =>
				apiBudget(work.db, "experiment", 2).reserve(1, { provider: "two" }),
			).toThrow("exhausted");
			budget.settle(first, 0.1, { usage: "reported" });
			budget.reserve(1, { provider: "two" });
			expect(budget.status().committedCostCeilingUsd).toBe(1.1);
			expect(budget.status().actualBilledUsd).toBeNull();
			expect(() => budget.settle(first, 0, {})).toThrow();
			expect(() => apiBudget(work.db, "experiment", 3)).toThrow("frozen");
			expect(() => work.db.run("DELETE FROM api_budget_events")).toThrow(
				"append-only",
			);
		} finally {
			work.close();
		}
	});
	test("rejects settlement without a reservation or above it", () => {
		const work = openWorkDb(":memory:");
		try {
			const budget = apiBudget(work.db, "experiment", 1);
			expect(() => budget.settle("absent", 0, {})).toThrow();
			const id = budget.reserve(0.5, {});
			expect(() => budget.settle(id, 0.6, {})).toThrow();
			expect(() => apiBudget(work.db, "another", 10.01)).toThrow();
		} finally {
			work.close();
		}
	});
});
