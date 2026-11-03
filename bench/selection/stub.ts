/**
 * SYNTHETIC embed transport for tests and wiring checks: a deterministic character-bigram
 * bag-of-words over the batch it is given, L2-normalized so the Router package's dot product
 * behaves like a cosine. It has no model, no network and no semantics worth reporting — any
 * ranking it produces proves the wiring only, never selection quality.
 */
import { sha256 } from "../catalog/load.ts";
import type { EmbedTransport } from "./port.ts";

export const STUB_NETWORK = "stub";
export const STUB_MODEL_ID = "stub-bow-bigram";

export class StubEmbedTransport implements EmbedTransport {
	readonly network = STUB_NETWORK;

	async embed(texts: readonly string[]) {
		const vocab = new Map<string, number>();
		const counts = texts.map((text) => {
			const grams = new Map<string, number>();
			for (let i = 0; i + 2 <= text.length; i++) {
				const gram = text.slice(i, i + 2);
				grams.set(gram, (grams.get(gram) ?? 0) + 1);
				if (!vocab.has(gram)) vocab.set(gram, vocab.size);
			}
			return grams;
		});
		const dimension = vocab.size;
		const vectors = counts.map((grams) => {
			const vector = Array.from({ length: dimension }, () => 0);
			for (const [gram, n] of grams) {
				const index = vocab.get(gram);
				if (index !== undefined) vector[index] = n;
			}
			const norm = Math.hypot(...vector);
			return norm > 0 ? vector.map((v) => v / norm) : vector;
		});
		return {
			space: {
				modelId: STUB_MODEL_ID,
				revision: "0",
				artifactDigest: sha256("stub-bow-bigram-v1"),
				dimension,
			},
			vectors,
		};
	}
}
