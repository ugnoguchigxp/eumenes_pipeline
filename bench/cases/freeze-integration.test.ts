import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeEvaluation } from "./freeze.ts";
import { loadCases } from "./cases.ts";
import { runFormat } from "../format/run.ts";
import { runApiInference } from "../infer/run-api.ts";
import { BASELINE_CONDITION, CONDITIONS } from "../format/conditions.ts";
import {
	DEFAULT_HOST_PROMPT,
	loadHostPrompt,
	hostPromptIdentity,
} from "../format/host-prompt.ts";

test("frozen host evaluation rejects snapshot drift even outside the source tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "frozen-host-"));
	const casesDir = join(root, "cases");
	mkdirSync(casesDir);
	const c = {
		...loadCases()[0]!,
		id: "host-freeze-fixture",
		split: "holdout",
		group: "host-freeze-fixture",
	};
	writeFileSync(join(casesDir, `${c.id}.json`), JSON.stringify(c));
	const snapshot = JSON.parse(readFileSync(DEFAULT_HOST_PROMPT, "utf8"));
	const hostPromptPath = join(root, "host-prompt.json");
	writeFileSync(hostPromptPath, JSON.stringify(snapshot));
	const policyPath = join(root, "policy.json");
	writeFileSync(policyPath, "{}");
	const session = "host-frozen";
	const freezePath = join(root, "freeze.json");
	freezeEvaluation({
		path: freezePath,
		id: session,
		casesDir,
		policyPath,
		sessions: [session],
		protocol: {
			formatMethod: {
				condition: CONDITIONS.eumenes,
				formats: ["json"],
				repair: false,
				restoreSyntax: false,
				normalizeIds: false,
				triage: false,
				staged: false,
				coverageRepair: false,
				candidates: null,
				hostPrompt: hostPromptIdentity(loadHostPrompt(hostPromptPath)),
			},
		},
	});
	const options = {
		session,
		casesDir,
		runsRoot: join(root, "runs"),
		dbPath: ":memory:",
		formats: ["json"] as const,
		condition: CONDITIONS.eumenes,
		freezePath,
		hostPromptPath,
	};
	expect((await runFormat(options)).totals.missing).toBe(1);
	const requestPath = join(
		options.runsRoot,
		session,
		"requests",
		`${c.id}--json.json`,
	);
	const request = readFileSync(requestPath, "utf8");
	const changedInstructions = `${snapshot.instructions}\n追加の契約指示`;
	for (const changed of [
		{
			...snapshot,
			source: {
				...snapshot.source,
				toolchainRevisionId: "toolchain:pipeline.execute@1",
			},
		},
		{
			...snapshot,
			instructions: changedInstructions,
			instructionsSha256: createHash("sha256")
				.update(changedInstructions)
				.digest("hex"),
		},
	]) {
		writeFileSync(hostPromptPath, JSON.stringify(changed));
		await expect(runFormat(options)).rejects.toThrow("method differs");
		expect(readFileSync(requestPath, "utf8")).toBe(request);
	}
	writeFileSync(hostPromptPath, JSON.stringify(snapshot));
	expect((await runFormat(options)).totals.missing).toBe(1);
});
test("frozen evaluation blocks method changes and partial API batches before network access", async () => {
	const root = mkdtempSync(join(tmpdir(), "frozen-integration-"));
	const casesDir = join(root, "cases");
	mkdirSync(casesDir);
	const base = loadCases()[0]!;
	const c = {
		...base,
		id: "frozen-new-id",
		split: "holdout",
		group: "frozen-integration-only",
	};
	writeFileSync(join(casesDir, `${c.id}.json`), JSON.stringify(c));
	const runsRoot = join(root, "runs");
	const session = "frozen-batch";
	await runFormat({
		session,
		casesDir,
		runsRoot,
		dbPath: ":memory:",
		formats: ["json"],
	});
	const policyPath = join(root, "policy.json");
	writeFileSync(
		policyPath,
		JSON.stringify({
			id: "fixture",
			ceilingUsd: 1,
			approvedCeilingUsd: 1,
			maxOutputTokens: 100,
			timeoutMs: 100,
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
	const path = join(root, "freeze.json");
	freezeEvaluation({
		path,
		id: "fixture",
		casesDir,
		policyPath,
		sessions: [session],
		protocol: {
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
			apiSessions: {
				[session]: {
					provider: "openai",
					model: "fixture",
					phase: "compose",
					requestCount: 2,
				},
			},
		},
	});
	const frozen = await runFormat({
		session,
		casesDir,
		runsRoot,
		dbPath: ":memory:",
		formats: ["json"],
		freezePath: path,
	});
	expect(frozen.totals.missing).toBe(1);
	await expect(
		runFormat({
			session,
			casesDir,
			runsRoot,
			dbPath: ":memory:",
			formats: ["json"],
			freezePath: path,
			repair: true,
		}),
	).rejects.toThrow("method differs");
	let calls = 0;
	await expect(
		runApiInference({
			session,
			runsRoot,
			dbPath: join(root, "work.sqlite3"),
			provider: "openai",
			model: "fixture",
			budgetPath: policyPath,
			freezePath: path,
			env: { OPEN_AI_API_KEY: "fake" },
			fetcher: async () => {
				calls++;
				return Response.json({});
			},
		}),
	).rejects.toThrow("request count differs");
	expect(calls).toBe(0);
	expect(
		JSON.parse(readFileSync(path, "utf8")).protocol.apiSessions[session]
			.requestCount,
	).toBe(2);
});

test("same-size API input replacement is rejected even with a recomputed self-consistent digest", async () => {
	const root = mkdtempSync(join(tmpdir(), "frozen-content-")),
		casesDir = join(root, "cases"),
		runsRoot = join(root, "runs"),
		dbPath = join(root, "work.sqlite3"),
		policyPath = join(root, "policy.json"),
		freezePath = join(root, "freeze.json"),
		session = "sealed";
	mkdirSync(casesDir);
	const c = {
		...loadCases()[0]!,
		id: "frozen-content-only",
		split: "holdout",
		group: "new-content-family",
	};
	writeFileSync(join(casesDir, c.id + ".json"), JSON.stringify(c));
	const policy = {
		id: "fixture",
		ceilingUsd: 1,
		approvedCeilingUsd: 1,
		maxOutputTokens: 100,
		timeoutMs: 1000,
		note: "self-contained test fixture",
		profiles: [] as unknown[],
	};
	policy.profiles = [
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
	];
	writeFileSync(policyPath, JSON.stringify(policy));
	freezeEvaluation({
		path: freezePath,
		id: "fixture",
		casesDir,
		policyPath,
		sessions: [session],
		protocol: {
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
			apiSessions: {
				[session]: {
					provider: "openai",
					model: "fixture",
					phase: "compose",
					requestCount: 1,
				},
			},
		},
	});
	await runFormat({
		session,
		casesDir,
		runsRoot,
		dbPath,
		formats: ["json"],
		freezePath,
	});
	const file = join(runsRoot, session, "requests", c.id + "--json.json"),
		request = JSON.parse(readFileSync(file, "utf8"));
	request.prompt += "\nchanged after freeze";
	const { inferenceDigest } = await import("../infer/recorded.ts");
	request.promptDigest = inferenceDigest(request);
	writeFileSync(file, JSON.stringify(request));
	let calls = 0;
	await expect(
		runApiInference({
			session,
			runsRoot,
			dbPath,
			provider: "openai",
			model: "fixture",
			budgetPath: policyPath,
			freezePath,
			env: { OPEN_AI_API_KEY: "fake" },
			fetcher: async () => {
				calls++;
				return Response.json({});
			},
		}),
	).rejects.toThrow("requests differ");
	expect(calls).toBe(0);
});
