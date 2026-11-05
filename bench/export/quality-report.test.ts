import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../cases/cases.ts";
import { freezeEvaluation } from "../cases/freeze.ts";
import { BASELINE_CONDITION } from "../format/conditions.ts";
import { runFormat } from "../format/run.ts";
import { SYNTHETIC_OUTPUTS } from "../format/synthetic.ts";
import { runApiInference } from "../infer/run-api.ts";
import { inferenceDigest } from "../infer/recorded.ts";
import { buildRecordedJudgeRequest } from "../scoring/judge.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import { prepareJudgements } from "../scoring/prepare-judge.ts";
import { runQualityReport } from "./quality-report.ts";

const approved = JSON.stringify({
	verdict: "appropriate",
	criteria: {
		coverage: "pass",
		selection: "pass",
		dependencies: "pass",
		delivery: "pass",
		unnecessaryActions: "pass",
	},
	rationale: "synthetic test judgement",
});
async function fixture(runJudge = true) {
	const root = mkdtempSync(join(tmpdir(), "quality-report-review-")),
		runsRoot = join(root, "runs"),
		dbPath = join(root, "work.sqlite3"),
		casesDir = join(root, "cases"),
		budgetPath = join(root, "policy.json"),
		freezePath = join(root, "freeze.json");
	mkdirSync(casesDir);
	const c = loadCases().find((c) => c.id === "prime-count")!;
	writeFileSync(join(casesDir, c.id + ".json"), JSON.stringify(c));
	writeFileSync(
		budgetPath,
		JSON.stringify({
			id: "fixture",
			ceilingUsd: 1,
			approvedCeilingUsd: 1,
			maxOutputTokens: 1000,
			timeoutMs: 1000,
			note: "fixture",
			profiles: [
				{
					provider: "openai",
					model: "fixture",
					contextTokensCeiling: 1000,
					inputUsdPerMillionCeiling: 1,
					outputUsdPerMillionCeiling: 1,
					pricingSource: "https://example.test",
					pricingCheckedAt: "fixture",
					settings: {},
				},
			],
		}),
	);
	const freeze = freezeEvaluation({
		path: freezePath,
		id: "fixture",
		casesDir,
		policyPath: budgetPath,
		sessions: ["source", "judge"],
		protocol: {
			intent: "recording-regrade",
			formatMethod: {
				condition: BASELINE_CONDITION,
				formats: ["json"],
				repair: false,
				restoreSyntax: false,
				normalizeIds: false,
				triage: false,
				staged: false,
				coverageRepair: false,
				candidates: null,
			},
			judge: { nativeSchema: true },
			apiSessions: {
				source: {
					provider: "openai",
					model: "fixture",
					phase: "compose",
					requestCount: 1,
				},
				judge: {
					provider: "openai",
					model: "fixture",
					phase: "judge",
					requestCount: 1,
					source: "source",
					qualified: true,
				},
			},
		},
	});
	const format = {
		session: "source",
		runsRoot,
		dbPath,
		casesDir,
		formats: ["json"] as const,
		freezePath,
	};
	await runFormat(format);
	const output = SYNTHETIC_OUTPUTS.find(
		(x) => x.caseId === c.id && x.format === "json",
	)!.output;
	let httpRequests = 0;
	const api = async (
		session: string,
		phase: "compose" | "judge",
		text: string,
	) =>
		runApiInference({
			session,
			phase,
			runsRoot,
			dbPath,
			budgetPath,
			...(["source", "judge"].includes(session) ? { freezePath } : {}),
			provider: "openai",
			model: "fixture",
			env: { OPEN_AI_API_KEY: "fixture-key" },
			fetcher: async () => {
				httpRequests++;
				return Response.json({
					model: "fixture",
					status: "completed",
					usage: { input_tokens: 10, output_tokens: 20 },
					output: [
						{ type: "message", content: [{ type: "output_text", text }] },
					],
				});
			},
		});
	await api("source", "compose", output);
	await runFormat(format);
	const catalog = loadBenchCatalog();
	const prepare = (session: string, candidate: string) => {
		const request = buildRecordedJudgeRequest({
			request: c.request,
			providedMaterials: c.providedMaterials,
			cards: catalog.cards,
			catalog: catalog.view,
			output: candidate,
			nativeSchema: true,
		});
		const dir = join(runsRoot, session, "judge-requests");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "prime-count--json.json"),
			JSON.stringify({ ...request, promptDigest: inferenceDigest(request) }),
		);
	};
	prepareJudgements({
		source: "source",
		session: "judge",
		casesDir,
		nativeSchema: true,
		freezePath,
		dbPath,
		runsRoot,
	});
	if (runJudge) await api("judge", "judge", approved);
	const options = {
		freezePath,
		budgetPath,
		dbPath,
		runsRoot,
		out: join(root, "report.json"),
	};
	return {
		root,
		runsRoot,
		options,
		prepare,
		api,
		close: () => catalog.close(),
		freeze,
		format,
		casesDir,
		get httpRequests() {
			return httpRequests;
		},
	};
}

test("blinded judgements must match the exact scored candidate, not just an authentic API output", async () => {
	const f = await fixture();
	try {
		expect(
			runQualityReport(f.options).generations[0]?.qualifiedJudgeAppropriate,
		).toBe(1);
		f.prepare(
			"unrelated",
			JSON.stringify({
				status: "unsupported",
				reasons: ["different candidate"],
			}),
		);
		await f.api("unrelated", "judge", approved);
		for (const dir of ["judge-recordings", "api-provenance/judge-recordings"])
			copyFileSync(
				join(f.runsRoot, "unrelated", dir, "prime-count--json.json"),
				join(f.runsRoot, "judge", dir, "prime-count--json.json"),
			);
		const result = runQualityReport({
			...f.options,
			out: join(f.root, "swapped.json"),
		});
		expect(result.completed).toBe(false);
		expect(result.generations[0]?.qualifiedJudgeAppropriate).toBe(0);
		const report = JSON.parse(
			readFileSync(join(f.root, "swapped.json"), "utf8"),
		);
		expect(report.generations[0].cells[0].votes[0].error).toContain(
			"candidate",
		);
	} finally {
		f.close();
	}
});

test("reported API usage cannot be changed by editing an untrusted provenance sidecar", async () => {
	const f = await fixture();
	try {
		const p = join(
				f.runsRoot,
				"judge",
				"api-provenance/judge-recordings/prime-count--json.json",
			),
			s = JSON.parse(readFileSync(p, "utf8"));
		s.usage.inputTokens = 0;
		s.durationMs = 0;
		writeFileSync(p, JSON.stringify(s));
		expect(() => runQualityReport(f.options)).toThrow("usage or duration");
	} finally {
		f.close();
	}
});

test("frozen judge input changes cannot spend budget even when the request digest is updated", async () => {
	const f = await fixture(false);
	try {
		const file = join(
				f.runsRoot,
				"judge",
				"judge-requests/prime-count--json.json",
			),
			request = JSON.parse(readFileSync(file, "utf8"));
		request.prompt += " changed";
		request.promptDigest = inferenceDigest(request);
		writeFileSync(file, JSON.stringify(request));
		const before = f.httpRequests;
		await expect(f.api("judge", "judge", approved)).rejects.toThrow(
			"requests differ",
		);
		expect(f.httpRequests).toBe(before);
	} finally {
		f.close();
	}
});

test("a single API judgement cannot be counted as two independent requests", async () => {
	const f = await fixture();
	try {
		const protocol = structuredClone(f.freeze.protocol) as any;
		protocol.apiSessions["judge-copy"] = { ...protocol.apiSessions.judge };
		const freezePath = join(f.root, "duplicated-freeze.json");
		freezeEvaluation({
			path: freezePath,
			id: "duplicate",
			casesDir: f.casesDir,
			policyPath: f.options.budgetPath,
			sessions: ["source", "judge", "judge-copy"],
			protocol,
		});
		await runFormat({ ...f.format, freezePath });
		for (const dir of ["judge-recordings", "api-provenance/judge-recordings"]) {
			mkdirSync(join(f.runsRoot, "judge-copy", dir), { recursive: true });
			copyFileSync(
				join(f.runsRoot, "judge", dir, "prime-count--json.json"),
				join(f.runsRoot, "judge-copy", dir, "prime-count--json.json"),
			);
		}
		expect(() => runQualityReport({ ...f.options, freezePath })).toThrow(
			"reused as an independent",
		);
	} finally {
		f.close();
	}
});
