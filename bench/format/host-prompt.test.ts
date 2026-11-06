import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases } from "../cases/cases.ts";
import {
	buildHostPrompt,
	DEFAULT_HOST_PROMPT,
	eumenesCard,
	loadHostPrompt,
	parseHostOutput,
} from "./host-prompt.ts";

test("the host prompt sends Eumenes' instructions and JSON message, never the gold", () => {
	const host = loadHostPrompt();
	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	const evalCase = loadCases().find((c) => c.providedMaterials.length > 0);
	if (!evalCase) throw new Error("a case with provided materials is needed");
	const built = buildHostPrompt({ evalCase, cards: catalog.cards, host });
	catalog.close();
	expect(built.system).toBe(host.instructions);
	const message = JSON.parse(built.prompt);
	expect(Object.keys(message)).toEqual([
		"request",
		"providedMaterials",
		"answers",
		"cards",
	]);
	expect(message.request).toBe(evalCase.request);
	expect(message.answers).toEqual([]);
	expect(message.providedMaterials[0]).toEqual({
		ref: "material:1",
		label: `${evalCase.providedMaterials[0]!.name}（${evalCase.providedMaterials[0]!.kind}）`,
		kind: "resource",
		preview: "",
	});
	expect(message.cards).toHaveLength(catalog.cards.length);
	expect(built.prompt).not.toContain("expected");
	expect(built.prompt).not.toContain(JSON.stringify(evalCase.expected));
});

test("cards follow the host's mapping: entry as bundle, no completed-output schema", () => {
	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	const withArgs = catalog.cards.find((c) => c.arguments);
	const plain = catalog.cards.find((c) => !c.arguments);
	catalog.close();
	if (!withArgs || !plain) throw new Error("catalog needs both card kinds");
	expect(eumenesCard(withArgs)).toEqual({
		entry: withArgs.entry,
		bundle: withArgs.entry,
		title: withArgs.title,
		summary: withArgs.summary,
		useWhen: withArgs.useWhen,
		avoidWhen: withArgs.avoidWhen,
		arguments: withArgs.arguments,
		output: { schemaRef: null, origin: "missing" },
		effects: ["read", "write"],
		mayAskUser: true,
	});
	expect(Object.hasOwn(eumenesCard(plain), "arguments")).toBe(false);
});

test("a changed or dirty snapshot is refused", () => {
	const original = JSON.parse(readFileSync(DEFAULT_HOST_PROMPT, "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "host-prompt-"));
	const write = (name: string, value: unknown) => {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify(value));
		return path;
	};
	expect(() =>
		loadHostPrompt(
			write("tampered.json", {
				...original,
				instructions: `${original.instructions} `,
			}),
		),
	).toThrow("digest");
	expect(() =>
		loadHostPrompt(
			write("dirty.json", {
				...original,
				source: { ...original.source, bundleDirty: true },
			}),
		),
	).toThrow("uncommitted");
});

test("the host reading needs an explicit status and does not trim", () => {
	const definition = {
		request: "r",
		steps: [
			{ id: "a", bundle: "b", task: "t", from: ["request"], result: "x" },
		],
		output: { from: ["a"], deliver: "d" },
	};
	expect(parseHostOutput(JSON.stringify(definition))).toMatchObject({
		ok: false,
		errors: [{ code: "status_required" }],
	});
	const wrapped = JSON.stringify({ status: "ready", definition });
	expect(parseHostOutput(wrapped)).toEqual({
		ok: true,
		outcome: { kind: "ready", definition },
	});
	expect(parseHostOutput(`\uFEFF${wrapped}`).ok).toBe(false);
	expect(parseHostOutput(`\n${wrapped}\n`).ok).toBe(true);
	expect(
		parseHostOutput('{"status":"ready","status":"ready","definition":{}}'),
	).toMatchObject({ ok: false, errors: [{ code: "duplicate_key" }] });
});
