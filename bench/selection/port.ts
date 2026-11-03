/**
 * The bench's candidate-selection port (plan §9, §10): given a user request and the offered
 * component cards, return the entries ranked as candidates. This is the retrieval half of the
 * comparison only — whether the composing side then picks well from the candidates is a
 * separate number, and the two are never merged (plan §10: 候補の取りこぼしと、提示された
 * 候補から選ぶ誤りを分離して測る).
 *
 * Every result carries its provenance — the embedding network's name, the model artifact's
 * hash and the retrieval time — because Router-path numbers from different networks must
 * never be mixed in one table, and until the overlap between the evaluation cases and the
 * reranker's training sentences has been checked, scores from this path must not be called
 * accuracy on unseen data (plan §9; skeleton handoff §7).
 */
import type { ComponentCard } from "../../src/contracts/component.ts";

export type SelectionCandidate = {
	entry: string;
	/** 1-based position in the ranking. */
	rank: number;
	/** The retrieval score in the transport's space; null when the ranker reports none. */
	score: number | null;
};

export type SelectionProvenance = {
	/** The embedding network/deployment name (e.g. the Ruri network), null when unknown. */
	network: string | null;
	/** Hash of the embedding model artifact, null when the transport does not name one. */
	modelHash: string | null;
	/** ISO timestamp of the retrieval. */
	retrievedAt: string;
};

export type SelectionResult = {
	candidates: SelectionCandidate[];
	provenance: SelectionProvenance;
};

export interface SelectionPort {
	select(
		request: string,
		cards: readonly ComponentCard[],
	): Promise<SelectionResult>;
}

/**
 * The replaceable transport behind a selection adapter: batch-embed texts in ONE declared
 * vector space. Tests inject a deterministic stub; a live run injects the provider transport.
 * The space declaration (`modelId`, `revision`, `artifactDigest`, `dimension`) is the vendor
 * Router package's `VectorSpace`; vectors from two spaces are never compared.
 */
export type EmbedTransport = {
	/** The network/deployment name recorded as provenance. */
	readonly network: string;
	embed: (texts: readonly string[]) => Promise<{
		space: {
			modelId: string;
			revision: string;
			artifactDigest: string;
			dimension: number;
		};
		vectors: number[][];
	}>;
};
