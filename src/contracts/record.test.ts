import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, documentRecord } from "./record.ts";

const record = {
	formatId: "json-pretty",
	contractVersion: CONTRACT_VERSION,
	documentVersion: 1,
	documentDigest: "a".repeat(64),
	sourceRequestDigest: "0123456789abcdef".repeat(4),
	catalogVersion: "3be9a125394c",
};

describe("documentRecord", () => {
	test("accepts a valid record; revisionOf is optional", () => {
		expect(documentRecord.safeParse(record).success).toBe(true);
		expect(documentRecord.safeParse({ ...record, revisionOf: 1 }).success).toBe(
			true,
		);
	});

	test("rejects digests that are not 64 lowercase hex characters", () => {
		expect(
			documentRecord.safeParse({ ...record, documentDigest: "abc" }).success,
		).toBe(false);
		expect(
			documentRecord.safeParse({
				...record,
				sourceRequestDigest: "A".repeat(64),
			}).success,
		).toBe(false);
	});

	test("rejects a non-positive document version", () => {
		expect(
			documentRecord.safeParse({ ...record, documentVersion: 0 }).success,
		).toBe(false);
	});
});
