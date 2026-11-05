import { expect, test } from "bun:test";
import {
	allowApiEndpoint,
	apiCredential,
	API_ENDPOINTS,
} from "./api-config.ts";

test("profile aliases take priority without changing the environment", () => {
	const env = { OPEN_AI_API_KEY: "preferred", OPENAI_API_KEY: "fallback" };
	expect(apiCredential("openai", env)).toEqual({
		name: "OPEN_AI_API_KEY",
		key: "preferred",
	});
	expect(
		apiCredential("anthropic", { ANTHROPIC_API_KEY: "fallback" }).name,
	).toBe("ANTHROPIC_API_KEY");
	expect(() => apiCredential("anthropic", { CLAUDE_API_KEY: " " })).toThrow(
		"No .env",
	);
	expect(env.OPENAI_API_KEY).toBe("fallback");
});

test("API allowances reject suffix hosts, alternate paths, credentials and queries", () => {
	const allowed = allowApiEndpoint("openai");
	expect(allowed(API_ENDPOINTS.openai)).toBe(true);
	for (const url of [
		"https://api.openai.com.attacker/v1/responses",
		"https://api.openai.com/v1/responses/",
		"https://api.openai.com/v1/responses?x=1",
		"http://api.openai.com/v1/responses",
		"https://user@api.openai.com/v1/responses",
		"https://api.openai.com:123/v1/responses",
	])
		expect(allowed(url)).toBe(false);
});
