/**
 * The live embed transport: an HTTP endpoint that embeds texts for the Router path.
 *
 * Configuration is environment-only, and BOTH variables are required:
 * - `PIPELINE_EMBED_URL`: the provider endpoint. Expected contract (the bench's side of the
 *   agreement, to be confirmed against the deployed provider in P0d): POST a JSON body
 *   `{"texts": string[]}` and answer 200 with `{"space": {modelId, revision, artifactDigest,
 *   dimension}, "vectors": number[][]}` where `vectors[i]` embeds `texts[i]` in `space`.
 * - `PIPELINE_EMBED_NETWORK`: the network/deployment name recorded as provenance (e.g. the
 *   Ruri network name). Scores from different networks are never mixed (skeleton handoff §7).
 *
 * Nothing here starts, stops or reconfigures a provider (AGENTS.md). When the configuration
 * is absent the CLI reports the path as not configured / not measured — in this environment
 * (checked 2026-11-03) neither variable is set, so no live connection has been attempted.
 * The CLI installs the reach guard with `allowFetch` for exactly this endpoint; any other
 * fetch stays blocked.
 */
import { z } from "zod";
import type { EmbedTransport } from "./port.ts";

export const EMBED_URL_ENV = "PIPELINE_EMBED_URL";
export const EMBED_NETWORK_ENV = "PIPELINE_EMBED_NETWORK";

export type LiveConfig = { url: string; network: string };

export type LiveConfigStatus =
	| { kind: "ready"; config: LiveConfig }
	| { kind: "missing"; missing: string[] };

export function liveConfigStatus(
	env: Record<string, string | undefined> = process.env,
): LiveConfigStatus {
	const missing = [EMBED_URL_ENV, EMBED_NETWORK_ENV].filter(
		(name) => !env[name],
	);
	if (missing.length > 0) return { kind: "missing", missing };
	return {
		kind: "ready",
		config: {
			url: env[EMBED_URL_ENV] as string,
			network: env[EMBED_NETWORK_ENV] as string,
		},
	};
}

const embedResponse = z.strictObject({
	space: z.strictObject({
		modelId: z.string().min(1),
		revision: z.string().min(1),
		artifactDigest: z.string().min(1),
		dimension: z.number().int().positive(),
	}),
	vectors: z.array(z.array(z.number().finite())),
});

export class HttpEmbedTransport implements EmbedTransport {
	readonly network: string;
	readonly #url: string;

	constructor(config: LiveConfig) {
		this.#url = config.url;
		this.network = config.network;
	}

	async embed(texts: readonly string[]) {
		const response = await fetch(this.#url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ texts }),
		});
		if (!response.ok)
			throw new Error(
				`embed endpoint answered ${response.status} for ${texts.length} texts`,
			);
		const parsed = embedResponse.safeParse(await response.json());
		if (!parsed.success)
			throw new Error(
				`embed endpoint response has an unexpected shape: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
			);
		return parsed.data;
	}
}
