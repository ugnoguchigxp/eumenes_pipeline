/**
 * Run one authored attempt through the bench: parse result → `checkDefinition` → mock execution.
 * This is the evaluator's harness, the only place besides tests that touches gold-adjacent flow —
 * and it still never passes a case (or anything derived from `expected`) to the checker or the
 * mock: the checker sees the definition and the catalog, the mock sees the checked plan alone.
 */
import { checkDefinition, type CheckResult } from "../../src/check.ts";
import type { CatalogView } from "../../src/catalog.ts";
import type { ContractSet } from "../catalog/contracts.ts";
import type { ParseResult } from "../formats/outcome.ts";
import { runPlan, type RunOutcome } from "../mock/driver.ts";
import { MockHost } from "../mock/host.ts";

export type AttemptResults = {
	parse: ParseResult;
	/** Present when the attempt was a `ready` outcome and got checked. */
	check?: CheckResult;
	/** Present when the check passed and the plan was executed on the mock host. */
	run?: RunOutcome;
};

export type AttemptEnv = {
	view: CatalogView;
	contracts: ContractSet;
	/** Fixed default seed: mock outputs are deterministic for a given attempt. */
	seed?: string;
};

export const DEFAULT_ATTEMPT_SEED = "bench-scoring-v1";

export async function runAttempt(
	parse: ParseResult,
	env: AttemptEnv,
	runId: string,
): Promise<AttemptResults> {
	if (!parse.ok || parse.outcome.kind !== "ready") return { parse };
	const check = checkDefinition(parse.outcome.definition, env.view);
	if (!check.ok) return { parse, check };
	const host = new MockHost({
		catalog: env.view,
		contracts: env.contracts,
		seed: env.seed ?? DEFAULT_ATTEMPT_SEED,
	});
	const run = await runPlan(check.plan, host, {
		runId,
		validateOutput: env.contracts.validate,
	});
	return { parse, check, run };
}
