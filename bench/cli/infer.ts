import { parseArgs } from "node:util";
import { installGuard } from "../mock/guard.ts";
import { allowApiEndpoint } from "../infer/api-config.ts";
import { runApiInference } from "../infer/run-api.ts";

const { values } = parseArgs({
	options: {
		provider: { type: "string" },
		model: { type: "string" },
		session: { type: "string" },
		budget: { type: "string" },
		freeze: { type: "string" },
		db: { type: "string" },
		phase: { type: "string", default: "compose" },
		case: { type: "string" },
	},
});
if (
	(values.provider !== "openai" && values.provider !== "anthropic") ||
	!values.model ||
	!values.session ||
	!values.budget ||
	!["compose", "repair", "judge"].includes(values.phase)
)
	throw new Error(
		"bench:infer requires --provider openai|anthropic --model ID --session NAME --budget FILE [--phase compose|repair|judge]",
	);
installGuard({ allowFetch: allowApiEndpoint(values.provider) });
const report = await runApiInference({
	provider: values.provider,
	model: values.model,
	session: values.session,
	budgetPath: values.budget,
	...(values.freeze ? { freezePath: values.freeze } : {}),
	phase: values.phase as "compose" | "repair" | "judge",
	...(values.db ? { dbPath: values.db } : {}),
	...(values.case ? { caseIds: values.case.split(",") } : {}),
});
console.log(JSON.stringify(report));
process.exit(report.completed ? 0 : 1);
