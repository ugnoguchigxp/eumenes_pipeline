import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { freezeEvaluation } from "../cases/freeze.ts";
import { installGuard } from "../mock/guard.ts";
installGuard();
const { values } = parseArgs({
	options: {
		protocol: { type: "string" },
		cases: { type: "string" },
		budget: { type: "string" },
		out: { type: "string" },
	},
});
if (!values.protocol || !values.cases || !values.budget || !values.out)
	throw new Error(
		"requires --protocol FILE --cases DIR --budget FILE --out NEW_FILE",
	);
const protocol = JSON.parse(readFileSync(values.protocol, "utf8"));
const freeze = freezeEvaluation({
	path: values.out,
	id: protocol.id,
	casesDir: values.cases,
	policyPath: values.budget,
	sessions: Object.keys(protocol.apiSessions),
	protocol,
});
console.log(
	JSON.stringify({
		id: freeze.id,
		digest: freeze.digest,
		sourceSha256: freeze.sourceSha256,
		caseSetSha256: freeze.caseSetSha256,
	}),
);
