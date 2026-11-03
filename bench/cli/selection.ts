/**
 * bench:selection — Router-path candidate selection over the seed cases.
 *
 *   bun run bench:selection [--transport live|stub] [--case id,id] [--db <path>]
 *
 * Default is `live`: with no provider configuration (`PIPELINE_EMBED_URL` /
 * `PIPELINE_EMBED_NETWORK`) nothing is connected and nothing is recorded — the path is
 * reported as not configured / not measured, and the command still exits 0. With a
 * configuration, the reach guard is installed allowing fetch to exactly that endpoint and
 * nothing else; the provider itself is never started, stopped or reconfigured.
 * `--transport stub` runs the synthetic wiring transport instead and labels every line as
 * synthetic: its rankings prove the path, never selection quality.
 */
import { parseArgs } from "node:util";
import { installGuard } from "../mock/guard.ts";
import { HttpEmbedTransport, liveConfigStatus } from "../selection/live.ts";
import type { SelectionPort } from "../selection/port.ts";
import { RouterSelection } from "../selection/router.ts";
import { runSelection } from "../selection/run.ts";
import { StubEmbedTransport } from "../selection/stub.ts";

const { values } = parseArgs({
	options: {
		transport: { type: "string", default: "live" },
		case: { type: "string" },
		db: { type: "string" },
	},
});

let selection: SelectionPort;
let label: string;
if (values.transport === "stub") {
	installGuard();
	selection = new RouterSelection(new StubEmbedTransport());
	label = "stub (synthetic)";
} else if (values.transport === "live") {
	const status = liveConfigStatus();
	if (status.kind === "missing") {
		console.log(
			`bench:selection: Router経路は未設定です（不足: ${status.missing.join(", ")}）。Provider へは接続せず、この経路は未測定として残します。`,
		);
		process.exit(0);
	}
	installGuard({ allowFetch: (url) => url === status.config.url });
	selection = new RouterSelection(new HttpEmbedTransport(status.config));
	label = `live:${status.config.network}`;
} else {
	console.error(
		`bench:selection: unknown --transport "${values.transport}" (live | stub)`,
	);
	process.exit(2);
}

const report = await runSelection(selection, {
	transportLabel: label,
	...(values.db ? { dbPath: values.db } : {}),
	...(values.case ? { caseIds: values.case.split(",") } : {}),
});
for (const { caseId, result } of report.results) {
	const top = result.candidates
		.slice(0, 5)
		.map((c) => `${c.rank}. ${c.entry} (${c.score?.toFixed(4) ?? "null"})`)
		.join("  ");
	console.log(
		`${caseId}: ${top}  [network=${result.provenance.network}, modelHash=${result.provenance.modelHash?.slice(0, 12)}…, at=${result.provenance.retrievedAt}]`,
	);
}
console.log(
	`run ${report.runId}; transport ${label}; ${report.results.length} cases`,
);
console.log(
	"注意: Router経路の候補・スコアは、評価ケースと学習文の重なりを確認できるまで未見データでの精度とは呼びません（plan §9）。",
);
