/**
 * Host-side record of a definition document (plan §3): the management values that travel with
 * a document but are not part of the definition itself.
 *
 * The host computes and records these values; the composing AI never writes them. Computing
 * the digests is the host's / bench's job — this package depends on no environment API, so
 * the record fixes only the shape and the formats.
 */
import { z } from "zod";

/** Version of the comparison contracts fixed in P0b; bump it when the contract changes. */
export const CONTRACT_VERSION = "p0-2";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInt = z.number().int().positive();

export const documentRecord = z.strictObject({
	/** The description format the document text is written in (e.g. a bench format id). */
	formatId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
	contractVersion: z.string().min(1).max(40),
	/** Document version; the original is 1 and each revision increments it. */
	documentVersion: positiveInt,
	/** SHA-256 of the document text as written, lowercase hex. */
	documentDigest: digest,
	/** SHA-256 of the user's original request text, lowercase hex. */
	sourceRequestDigest: digest,
	/** The catalog version the document was checked against. */
	catalogVersion: z.string().min(1).max(80),
	/** The document version this one revises, when it is a revision. */
	revisionOf: positiveInt.optional(),
});
export type DocumentRecord = z.infer<typeof documentRecord>;
