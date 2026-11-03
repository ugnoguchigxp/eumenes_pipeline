/**
 * Candidate selection over the vendor Router package (`eumenes_router`, plan §8): the
 * package builds each card's passages (`cardPassages`) and ranks cards by their closest
 * passage to the request (`closestSimilarities` + `rankBy`). Only this retrieval layer is
 * reused in P0c. The package's conversation decision (`route()`) and its trained best-v2
 * scorer are NOT used here, and no word-list bonus of the `RESOURCE_WORDS` kind is applied
 * anywhere: lexical bonuses are a P0d condition to measure, never a silent ingredient
 * (plan §8; AGENTS.md).
 *
 * The composing side's cards have no example requests, so passages are built from title,
 * summary and use cases alone. All texts (request first, then every card's passages) are
 * embedded in ONE transport call, so every vector compared here shares one space.
 */
import { cardPassages, closestSimilarities, rankBy } from "eumenes_router";
import type { ComponentCard } from "../../src/contracts/component.ts";
import type { EmbedTransport, SelectionPort, SelectionResult } from "./port.ts";

export class RouterSelection implements SelectionPort {
	constructor(private readonly transport: EmbedTransport) {}

	async select(
		request: string,
		cards: readonly ComponentCard[],
	): Promise<SelectionResult> {
		const perCard = cards.map((card) => ({
			entry: card.entry,
			passages: cardPassages({
				title: card.title,
				summary: card.summary,
				useWhen: card.useWhen,
				examples: [],
			}),
		}));
		const texts = [request, ...perCard.flatMap((c) => c.passages)];
		const { space, vectors } = await this.transport.embed(texts);
		if (vectors.length !== texts.length)
			throw new Error(
				`embed transport returned ${vectors.length} vectors for ${texts.length} texts`,
			);
		// One space or nothing: a vector of the wrong dimension or with non-finite values
		// would silently corrupt every comparison below, so it is refused here.
		for (const vector of vectors)
			if (
				vector.length !== space.dimension ||
				!vector.every((v) => Number.isFinite(v))
			)
				throw new Error(
					`embed transport returned a vector outside the declared space (dimension ${space.dimension})`,
				);
		const query = vectors[0];
		if (!query) throw new Error("embed transport returned no query vector");
		const rows: Array<{ id: string; values: ArrayLike<number> }> = [];
		let offset = 1;
		for (const card of perCard) {
			for (const _passage of card.passages) {
				const values = vectors[offset];
				if (values) rows.push({ id: card.entry, values });
				offset += 1;
			}
		}
		const similarity = closestSimilarities(
			rows,
			query,
			new Set(cards.map((c) => c.entry)),
		);
		const ranked = rankBy(
			cards.map((c) => ({ id: c.entry })),
			similarity,
		);
		return {
			candidates: ranked.map((entry, index) => ({
				entry: entry.id,
				rank: index + 1,
				score: similarity.get(entry.id) ?? null,
			})),
			provenance: {
				network: this.transport.network,
				modelHash: space.artifactDigest,
				retrievedAt: new Date().toISOString(),
			},
		};
	}
}
