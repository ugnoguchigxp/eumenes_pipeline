import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	deriveHostPrompt,
	revisionId,
	type PromptBundle,
} from "./eumenes-prompt.ts";

const bundle = (revisions: number[]): PromptBundle => ({
	bundleId: "pipeline-execution",
	definitions: revisions.flatMap((revision) => [
		{
			kind: "profile",
			id: "pipeline.execute",
			revision,
			body: ` profile ${revision} `,
		},
		{
			kind: "skill",
			id: "pipeline.execute",
			revision,
			body: ` skill ${revision} `,
		},
		{
			kind: "package",
			id: "pipeline.execute",
			revision,
			profileRevisionId: `profile:pipeline.execute@${revision}`,
			requiredSkillRevisionIds: [`skill:pipeline.execute@${revision}`],
		},
		{
			kind: "toolchain",
			id: "pipeline.execute",
			revision,
			packageRevisionId: `package:pipeline.execute@${revision}`,
			bindingRevisionId: "binding:pipeline.execute@2",
		},
	]),
	bindings: [{ id: "pipeline.execute", revision: 2, contractVersion: "p0-3" }],
});

test("a single revision preserves legacy extraction and instruction bytes", () => {
	const derived = deriveHostPrompt(bundle([1]));
	expect(revisionId(derived.toolchain)).toBe("toolchain:pipeline.execute@1");
	expect(derived.instructions).toBe("profile 1\n\nskill 1");
});

test.each([1, 2])(
	"an explicit revision %d is invariant under definition order",
	(revision) => {
		const original = bundle([1, 2]);
		const reversed = {
			...original,
			definitions: [...original.definitions].reverse(),
		};
		const selection = {
			toolchainRevisionId: `toolchain:pipeline.execute@${revision}`,
		};
		expect(deriveHostPrompt(original, selection)).toEqual(
			deriveHostPrompt(reversed, selection),
		);
		expect(deriveHostPrompt(original, selection).instructions).toBe(
			`profile ${revision}\n\nskill ${revision}`,
		);
	},
);

test("multiple or missing revisions cannot silently choose an entry", () => {
	expect(() => deriveHostPrompt(bundle([1, 2]))).toThrow(
		"specify --toolchain-revision",
	);
	expect(() => deriveHostPrompt(bundle([]))).toThrow(
		"specify --toolchain-revision",
	);
	expect(() =>
		deriveHostPrompt(bundle([1, 2]), {
			toolchainRevisionId: "toolchain:pipeline.execute@3",
		}),
	).toThrow("unknown");
});

test("expected adopted instructions must match the selected revision", () => {
	const original = bundle([1, 2]);
	const old = deriveHostPrompt(original, {
		toolchainRevisionId: "toolchain:pipeline.execute@1",
	});
	expect(
		deriveHostPrompt(original, {
			toolchainRevisionId: "toolchain:pipeline.execute@1",
			expectedInstructionsSha256: old.instructionsSha256,
		}),
	).toEqual(old);
	expect(() =>
		deriveHostPrompt(original, {
			toolchainRevisionId: "toolchain:pipeline.execute@2",
			expectedInstructionsSha256: old.instructionsSha256,
		}),
	).toThrow("expected host digest");
});

test("duplicate revisions and broken references are refused", () => {
	expect(() => deriveHostPrompt(bundle([1, 1]))).toThrow(
		"duplicate definition",
	);
	const broken = bundle([1]);
	broken.definitions = broken.definitions.filter((d) => d.kind !== "skill");
	expect(() => deriveHostPrompt(broken)).toThrow("missing skill reference");
	const noBinding = { ...bundle([1]), bindings: [] };
	expect(() => deriveHostPrompt(noBinding)).toThrow("binding reference");
});

test("the committed single-revision prompt is reproduced without changing its snapshot", () => {
	const snapshot = JSON.parse(
		readFileSync("data/contracts/eumenes-compose-prompt.json", "utf8"),
	);
	const original = bundle([1]);
	const profile = original.definitions.find((d) => d.kind === "profile")!;
	const skill = original.definitions.find((d) => d.kind === "skill")!;
	const [profileBody, skillBody] = snapshot.instructions.split("\n\n");
	profile.body = profileBody;
	skill.body = skillBody;
	const derived = deriveHostPrompt(original, {
		toolchainRevisionId: snapshot.source.toolchainRevisionId,
		expectedInstructionsSha256: snapshot.instructionsSha256,
	});
	expect(derived.instructions).toBe(snapshot.instructions);
});
