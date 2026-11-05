/** Credential aliases are connection configuration, never model semantic decisions. */
export type ApiProvider = "anthropic" | "openai";
export const API_ENDPOINTS = {
	anthropic: "https://api.anthropic.com/v1/messages",
	openai: "https://api.openai.com/v1/responses",
} as const;

const KEYS = {
	anthropic: ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"],
	openai: ["OPEN_AI_API_KEY", "OPENAI_API_KEY"],
} as const;

export function apiCredential(
	provider: ApiProvider,
	env: Record<string, string | undefined> = process.env,
) {
	for (const name of KEYS[provider]) {
		const key = env[name]?.trim();
		if (key) return { name, key };
	}
	throw new Error(
		`Missing ${KEYS[provider].join(" or ")}; start the bench through /bin/zsh -lc. No .env is required.`,
	);
}

export function allowApiEndpoint(provider: ApiProvider) {
	const expected = new URL(API_ENDPOINTS[provider]);
	return (value: string): boolean => {
		try {
			const url = new URL(value);
			return (
				url.protocol === expected.protocol &&
				url.host === expected.host &&
				url.pathname === expected.pathname &&
				url.search === "" &&
				url.hash === "" &&
				url.username === "" &&
				url.password === ""
			);
		} catch {
			return false;
		}
	};
}
