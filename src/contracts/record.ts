/** Host-generated provenance, never fields authored by the composing model. */
import { documentRecordSchema } from "../internal/schemas.ts";
import type { Schema } from "./schema.ts";
/** p0-3 narrows the public validator API to parse/safeParse; the document shape is unchanged. */
export const CONTRACT_VERSION = "p0-3";
export type DocumentRecord = {
	formatId: string;
	contractVersion: string;
	documentVersion: number;
	documentDigest: string;
	sourceRequestDigest: string;
	catalogVersion: string;
	revisionOf?: number;
};
export const documentRecord: Schema<DocumentRecord> = documentRecordSchema;
