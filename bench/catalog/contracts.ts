/**
 * Contract lookup for the bench: JSON Schemas by reference, and structural validators built from them.
 *
 * - `builtin:` / `domain:`: extracted from Eumenes code (`scripts/extract-eumenes-contracts.ts`).
 * - `schema:`: bundle JSON Schemas stored in the catalog snapshot.
 * - `fixture:`: bench-only contracts (`data/contracts/fixture-outputs.json`), never catalog evidence.
 *
 * Validators come from `z.fromJSONSchema`, so Zod refinements of the originals are not enforced here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ContractOrigin } from "../../src/contracts/component.ts";
import type { Snapshot } from "./snapshot.ts";

export const DEFAULT_CONTRACTS =
	"data/contracts/eumenes-contracts-2026-11-03.json";
export const DEFAULT_FIXTURES = "data/contracts/fixture-outputs.json";

export type JsonSchema = Record<string, unknown>;

type Extracted = {
	formatVersion: 1;
	source: Record<string, unknown>;
	builtin: Record<string, { jsonSchema: JsonSchema; unrepresentable: boolean }>;
	domain: Record<string, { jsonSchema: JsonSchema; unrepresentable: boolean }>;
	adapters: Record<
		string,
		{
			owner?: string | null;
			operations?: Array<{
				operationId: string;
				inputSchemaRef: string;
				effect: "read" | "write";
			}>;
			projections?: string[];
			error?: string;
		}
	>;
};

type Fixtures = {
	formatVersion: 1;
	reviewed: boolean;
	outputs: Record<string, { basis: string; schema: JsonSchema }>;
	entries: Record<string, string>;
};

export type ValidationResult =
	| { ok: true; value: unknown }
	| { ok: false; issues: Array<{ path: string; message: string }> };

const toResult = (
	result: ReturnType<z.ZodType["safeParse"]>,
): ValidationResult =>
	result.success
		? { ok: true, value: result.data }
		: {
				ok: false,
				issues: result.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			};

/** Validate against a JSON Schema that has no ref (e.g. a card's own arguments schema). */
export function validateAgainst(
	schema: JsonSchema,
	value: unknown,
): ValidationResult {
	return toResult(
		z
			.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
			.safeParse(value),
	);
}

export type ContractSet = {
	contractsSha256: string;
	fixturesSha256: string;
	fixturesReviewed: boolean;
	source: Record<string, unknown>;
	schema(ref: string): JsonSchema | undefined;
	origin(ref: string): ContractOrigin;
	validate(ref: string, value: unknown): ValidationResult;
	/** Fixture output contract ref for an entry, when one is defined. */
	fixtureOutput(entry: string): string | undefined;
	adapter(ref: string): Extracted["adapters"][string] | undefined;
};

const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");

export function loadContracts(
	snapshot: Snapshot,
	options: {
		contractsPath?: string;
		fixturesPath?: string;
		verify?: boolean;
	} = {},
): ContractSet {
	const contractsPath = options.contractsPath ?? DEFAULT_CONTRACTS;
	const contractsText = readFileSync(contractsPath, "utf8");
	const contractsSha256 = digest(contractsText);
	if (options.verify !== false) {
		const manifest = JSON.parse(
			readFileSync(contractsPath.replace(/\.json$/, ".manifest.json"), "utf8"),
		) as { sha256: string };
		if (manifest.sha256 !== contractsSha256)
			throw new Error(
				`contracts digest mismatch: ${contractsSha256} != manifest ${manifest.sha256}`,
			);
	}
	const extracted = JSON.parse(contractsText) as Extracted;
	const fixturesText = readFileSync(
		options.fixturesPath ?? DEFAULT_FIXTURES,
		"utf8",
	);
	const fixtures = JSON.parse(fixturesText) as Fixtures;

	const schemaCache = new Map<string, JsonSchema | undefined>();
	const schema = (ref: string): JsonSchema | undefined => {
		if (schemaCache.has(ref)) return schemaCache.get(ref);
		let found: JsonSchema | undefined;
		if (ref.startsWith("builtin:")) found = extracted.builtin[ref]?.jsonSchema;
		else if (ref.startsWith("domain:"))
			found = extracted.domain[ref]?.jsonSchema;
		else if (ref.startsWith("fixture:")) found = fixtures.outputs[ref]?.schema;
		else if (ref.startsWith("schema:"))
			found = snapshot.document<{ schema?: JsonSchema }>(ref)?.document.schema;
		schemaCache.set(ref, found);
		return found;
	};
	const validators = new Map<string, z.ZodType>();
	const validator = (ref: string): z.ZodType | undefined => {
		const cached = validators.get(ref);
		if (cached) return cached;
		const json = schema(ref);
		if (!json) return undefined;
		const built = z.fromJSONSchema(
			json as Parameters<typeof z.fromJSONSchema>[0],
		);
		validators.set(ref, built);
		return built;
	};

	return {
		contractsSha256,
		fixturesSha256: digest(fixturesText),
		fixturesReviewed: fixtures.reviewed,
		source: extracted.source,
		schema,
		origin(ref) {
			if (!schema(ref)) return "missing";
			if (ref.startsWith("fixture:")) return "fixture";
			if (ref.startsWith("schema:")) return "catalog";
			return "eumenes-code";
		},
		validate(ref, value) {
			const check = validator(ref);
			if (!check)
				return {
					ok: false,
					issues: [{ path: "", message: `unknown contract ${ref}` }],
				};
			const result = check.safeParse(value);
			return result.success
				? { ok: true, value: result.data }
				: {
						ok: false,
						issues: result.error.issues.map((issue) => ({
							path: issue.path.join("."),
							message: issue.message,
						})),
					};
		},
		fixtureOutput: (entry) => fixtures.entries[entry],
		adapter: (ref) => extracted.adapters[ref],
	};
}
