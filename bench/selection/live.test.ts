import { expect, test } from "bun:test";
import { HttpEmbedTransport } from "./live.ts";

test("embedding deadline aborts a stalled dependency and redirects are never followed", async () => {
	const previous = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		requests++;
		expect(init?.redirect).toBe("error");
		return new Promise<Response>((_resolve, reject) =>
			init?.signal?.addEventListener(
				"abort",
				() => reject(new Error("deadline")),
				{ once: true },
			),
		);
	}) as typeof fetch;
	try {
		const transport = new HttpEmbedTransport(
			{ url: "https://embed.test/", network: "fixture" },
			5,
		);
		await expect(transport.embed(["synthetic"])).rejects.toThrow("deadline");
		expect(requests).toBe(1);
		expect(
			() =>
				new HttpEmbedTransport(
					{ url: "https://embed.test/", network: "fixture" },
					0,
				),
		).toThrow("timeout");
	} finally {
		globalThis.fetch = previous;
	}
});
