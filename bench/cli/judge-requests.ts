/** Prepare blinded plan judgements without model calls. */
import { parseArgs } from "node:util";
import { prepareJudgements } from "../scoring/prepare-judge.ts";
import { installGuard } from "../mock/guard.ts";
installGuard();
const { values } = parseArgs({
	options: {
		source: { type: "string" },
		session: { type: "string" },
		cases: { type: "string" },
		freeze: { type: "string" },
		db: { type: "string" },
		"native-schema": { type: "boolean" },
	},
});
if (!values.source || !values.session)
	throw new Error(
		"judge preparation requires --source SESSION --session JUDGE_SESSION",
	);
console.log(
	JSON.stringify(
		prepareJudgements({
			source: values.source,
			session: values.session,
			casesDir: values.cases,
			freezePath: values.freeze,
			dbPath: values.db,
			nativeSchema: values["native-schema"],
		}),
	),
);
