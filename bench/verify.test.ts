import { expect, test } from "bun:test";
import { takeReachAttempts } from "./mock/guard.ts";
import { runVerify } from "./verify.ts";

test("bench:verify passes offline with zero reach attempts", async () => {
	// Other test files in this process probe the guard on purpose; start from a clean count.
	takeReachAttempts();
	const report = await runVerify({ dbPath: ":memory:" });
	const failed = report.checks.filter((c) => !c.ok);
	expect(failed).toEqual([]);
	expect(report.checks.find((c) => c.id === "guard/zero-reach")?.ok).toBe(true);
});
