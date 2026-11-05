import { describe, expect, test } from "bun:test";
import { ApiInference, type ApiEvidence, type ApiProfile } from "./api.ts";
import { openWorkDb } from "../store/work-db.ts";
import { apiBudget } from "../store/api-budget.ts";

const profile: ApiProfile = {
	provider: "openai",
	model: "fixture-model",
	contextTokensCeiling: 1000,
	inputUsdPerMillionCeiling: 1,
	outputUsdPerMillionCeiling: 5,
	pricingSource: "https://example.test/pricing",
	pricingCheckedAt: "fixture",
	settings: {},
};
const success = {
	id: "response",
	model: profile.model,
	status: "completed",
	output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
	usage: { input_tokens: 10, output_tokens: 2 },
};

describe("direct API inference", () => {
	test("Anthropic cache opt-in cannot be enabled through request overrides", () => {
		const work = openWorkDb(":memory:");
		try {
			expect(
				() =>
					new ApiInference(
						{
							...profile,
							provider: "anthropic",
							apiVersion: "2026-10-21",
							settings: { cache_control: { type: "ephemeral" } },
						},
						{
							budget: apiBudget(work.db, "no-cache", 1),
							maxOutputTokens: 100,
							timeoutMs: 1000,
						},
					),
			).toThrow("overrides are forbidden");
		} finally {
			work.close();
		}
	});
	test("maps the request without tools and records raw evidence with unknown costs/calls preserved", async () => {
		const work = openWorkDb(":memory:");
		try {
			const budget = apiBudget(work.db, "shared", 1);
			let evidence: ApiEvidence | undefined;
			const port = new ApiInference(profile, {
				budget,
				maxOutputTokens: 100,
				timeoutMs: 1000,
				env: { OPEN_AI_API_KEY: "secret-sample" },
				onEvidence: (e) => {
					evidence = e;
				},
				fetcher: async (url, init) => {
					expect(url).toBe("https://api.openai.com/v1/responses");
					expect(init.redirect).toBe("error");
					const body = JSON.parse(init.body as string);
					expect(body.instructions).toBe("system");
					expect(body.tools).toBeUndefined();
					expect(body.store).toBe(false);
					return Response.json(success, {
						headers: { "x-request-id": "provider-request" },
					});
				},
			});
			const result = await port.complete({
				purpose: "compose",
				system: "system",
				prompt: "request",
			});
			expect(result.ok).toBe(true);
			expect(result.usage.calls).toBeNull();
			expect(result.usage.cachedTokens).toBeNull();
			expect(evidence?.providerRequestId).toBe("provider-request");
			expect(JSON.stringify(evidence)).not.toContain("secret-sample");
			expect(budget.status().actualBilledUsd).toBeNull();
		} finally {
			work.close();
		}
	});
	test.each([401, 403, 429, 500])(
		"HTTP %d is one recorded failed call without hidden retry",
		async (status) => {
			const work = openWorkDb(":memory:");
			try {
				let calls = 0;
				const budget = apiBudget(work.db, "shared", 1);
				const port = new ApiInference(profile, {
					budget,
					maxOutputTokens: 100,
					timeoutMs: 1000,
					env: { OPEN_AI_API_KEY: "secret-sample" },
					fetcher: async () => {
						calls++;
						return Response.json({ error: "secret-sample" }, { status });
					},
				});
				const result = await port.complete({
					purpose: "compose",
					prompt: "request",
				});
				expect(result.ok).toBe(false);
				expect(calls).toBe(1);
				expect(budget.status().committedCostCeilingUsd).toBe(0.0015);
			} finally {
				work.close();
			}
		},
	);
	test.each([
		{ ...success, status: "incomplete" },
		{ ...success, model: "other-model" },
		{ ...success, output: [{ type: "function_call" }] },
		{ ...success, output: [] },
		{
			...success,
			output: [
				{ type: "message", content: [{ type: "refusal", refusal: "no" }] },
			],
		},
	])(
		"non-completion, changed model, tools, empty output and refusals do not become success",
		async (response) => {
			const work = openWorkDb(":memory:");
			try {
				const port = new ApiInference(profile, {
					budget: apiBudget(work.db, "shared", 1),
					maxOutputTokens: 100,
					timeoutMs: 1000,
					env: { OPEN_AI_API_KEY: "secret-sample" },
					fetcher: async () => Response.json(response),
				});
				expect(
					(await port.complete({ purpose: "compose", prompt: "request" })).ok,
				).toBe(false);
			} finally {
				work.close();
			}
		},
	);
	test("Anthropic text/usage mapping is separate from provider completion status", async () => {
		const work = openWorkDb(":memory:");
		try {
			let reason = "end_turn";
			const p = {
				...profile,
				provider: "anthropic" as const,
				apiVersion: "2026-10-21",
			};
			const port = new ApiInference(p, {
				budget: apiBudget(work.db, "shared", 1),
				maxOutputTokens: 100,
				timeoutMs: 1000,
				env: { CLAUDE_API_KEY: "secret-sample" },
				fetcher: async (_url, init) => {
					expect(new Headers(init.headers).get("x-api-key")).toBe(
						"secret-sample",
					);
					return Response.json({
						model: p.model,
						stop_reason: reason,
						content: [{ type: "text", text: "{}" }],
						usage: {
							input_tokens: 10,
							output_tokens: 2,
							cache_creation_input_tokens: 3,
							cache_read_input_tokens: 5,
						},
					});
				},
			});
			expect(
				(await port.complete({ purpose: "compose", prompt: "request" })).ok,
			).toBe(true);
			reason = "max_tokens";
			expect(
				(await port.complete({ purpose: "compose", prompt: "request" })).ok,
			).toBe(false);
		} finally {
			work.close();
		}
	});
	test("missing credentials, cancellation and exhausted budget cannot send a request", async () => {
		const work = openWorkDb(":memory:");
		try {
			let calls = 0;
			const budget = apiBudget(work.db, "shared", 0.0001);
			const port = new ApiInference(profile, {
				budget,
				maxOutputTokens: 100,
				timeoutMs: 10,
				env: {},
				fetcher: async () => {
					calls++;
					return Response.json(success);
				},
			});
			await expect(
				port.complete({ purpose: "compose", prompt: "x" }),
			).rejects.toThrow("No .env");
			expect(
				(
					await port.complete(
						{ purpose: "compose", prompt: "x" },
						{ aborted: true },
					)
				).ok,
			).toBe(false);
			const configured = new ApiInference(profile, {
				budget,
				maxOutputTokens: 100,
				timeoutMs: 10,
				env: { OPEN_AI_API_KEY: "secret-sample" },
				fetcher: async () => {
					calls++;
					return Response.json(success);
				},
			});
			await expect(
				configured.complete({ purpose: "compose", prompt: "x" }),
			).rejects.toThrow("exhausted");
			expect(calls).toBe(0);
		} finally {
			work.close();
		}
	});
	test("timeout and cancellation retain unknown reservations", async () => {
		const work = openWorkDb(":memory:");
		try {
			const budget = apiBudget(work.db, "shared", 1);
			const port = new ApiInference(profile, {
				budget,
				maxOutputTokens: 100,
				timeoutMs: 5,
				env: { OPEN_AI_API_KEY: "secret-sample" },
				fetcher: async (_url, init) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					}),
			});
			expect(
				(await port.complete({ purpose: "compose", prompt: "x" })).ok,
			).toBe(false);
			expect(budget.status().committedCostCeilingUsd).toBe(0.0015);
		} finally {
			work.close();
		}
	});
});

test("oversized response streams are cancelled before their entire body is read", async () => {
	const work = openWorkDb(":memory:");
	try {
		let reads = 0,
			cancelled = false;
		const budget = apiBudget(work.db, "stream-limit", 1);
		const port = new ApiInference(profile, {
			budget,
			maxOutputTokens: 100,
			timeoutMs: 1000,
			env: { OPEN_AI_API_KEY: "secret-sample" },
			fetcher: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							reads++;
							if (reads > 8) controller.close();
							else controller.enqueue(new Uint8Array(600_000));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		const result = await port.complete({ purpose: "compose", prompt: "x" });
		expect(result.ok).toBe(false);
		expect(cancelled).toBe(true);
		expect(reads).toBeLessThan(8);
		expect(budget.status().committedCostCeilingUsd).toBe(0.0015);
	} finally {
		work.close();
	}
});

test("escaped credentials and reflected response identifiers cannot enter saved evidence", async () => {
	const work = openWorkDb(":memory:");
	try {
		let evidence: ApiEvidence | undefined;
		const secret = "secret-sample";
		const port = new ApiInference(profile, {
			budget: apiBudget(work.db, "redaction", 1),
			maxOutputTokens: 100,
			timeoutMs: 1000,
			env: { OPEN_AI_API_KEY: secret },
			onEvidence: (value) => {
				evidence = value;
			},
			fetcher: async () =>
				new Response(
					JSON.stringify({
						...success,
						id: secret,
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: secret }],
							},
						],
					}).replaceAll(secret, "\\u0073ecret-sample"),
					{ headers: { "x-request-id": secret } },
				),
		});
		const result = await port.complete({ purpose: "compose", prompt: "x" });
		expect(result.ok).toBe(true);
		expect(JSON.stringify(evidence)).not.toContain(secret);
		if (result.ok) expect(result.text).not.toContain(secret);
	} finally {
		work.close();
	}
});

test("a stalled response body is cancelled at the deadline and retains its reservation", async () => {
	const work = openWorkDb(":memory:");
	try {
		let cancelled = false;
		const budget = apiBudget(work.db, "stalled-body", 1);
		const port = new ApiInference(profile, {
			budget,
			maxOutputTokens: 100,
			timeoutMs: 5,
			env: { OPEN_AI_API_KEY: "secret-sample" },
			fetcher: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		const result = await port.complete({ purpose: "compose", prompt: "x" });
		expect(result.ok).toBe(false);
		expect(cancelled).toBe(true);
		expect(budget.status().committedCostCeilingUsd).toBe(0.0015);
	} finally {
		work.close();
	}
});

test("wire input is bounded in UTF-8 bytes rather than character count", async () => {
	const work = openWorkDb(":memory:");
	try {
		let calls = 0;
		const budget = apiBudget(work.db, "wire-bytes", 1);
		const port = new ApiInference(profile, {
			budget,
			maxOutputTokens: 100,
			timeoutMs: 1000,
			env: { OPEN_AI_API_KEY: "secret-sample" },
			fetcher: async () => {
				calls++;
				return Response.json(success);
			},
		});
		const result = await port.complete({
			purpose: "compose",
			prompt: "文".repeat(80_000),
		});
		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
		expect(budget.status().committedCostCeilingUsd).toBe(0);
	} finally {
		work.close();
	}
});
