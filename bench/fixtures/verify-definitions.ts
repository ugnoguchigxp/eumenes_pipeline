/**
 * Synthetic definitions for `bench:verify` (wiring only). They are NOT evaluation cases: they check
 * that parser-free structure, references, catalog resolution, the mock host and the driver behave,
 * using real entry ids from the snapshot. Evaluation cases live in `data/cases/` (P0c, Muse).
 */
import type { IssueCode } from "../../src/check.ts";

export type ValidFixture = {
	id: string;
	note: string;
	definition: unknown;
};
export type InvalidFixture = ValidFixture & { expect: IssueCode };

const request = "江戸時代の町並みを調べて、解説付きの画像と30秒のBGMを作って";

export const VALID: ValidFixture[] = [
	{
		id: "single-ready",
		note: "one command entry with a domain output contract",
		definition: {
			request: "1から100までの素数の個数をPythonで計算して",
			steps: [
				{
					id: "count",
					bundle: "compute.python",
					task: "1から100までの素数の個数を計算する",
					from: ["request"],
					result: "素数の個数",
				},
			],
			output: { from: ["count"], deliver: "計算結果を伝える" },
		},
	},
	{
		id: "research-image-music",
		note: "plan §3 example on real entries: summary-only research, then two fixture outputs",
		definition: {
			request,
			steps: [
				{
					id: "research",
					bundle: "web.search",
					task: "江戸時代の町並みの特徴を、出典付きで調べる",
					from: ["request"],
					result: "画像とBGMの制作に使える調査結果",
				},
				{
					id: "picture",
					bundle: "image.create",
					task: "調査した町並みの特徴を反映した画像を作る",
					from: ["request", "research"],
					result: "町並みの画像1点",
				},
				{
					id: "music",
					bundle: "music.create",
					task: "調査した町並みの雰囲気に合う30秒のBGMを作る",
					from: ["request", "research"],
					result: "30秒のBGM1曲",
				},
			],
			output: {
				from: ["research", "picture", "music"],
				deliver: "画像とBGMを提示し、町並みの解説と調査の出典を添える",
			},
		},
	},
	{
		id: "instant-then-command",
		note: "an instant entry (typed arguments) handing on to a command entry",
		definition: {
			request: "明日の鎌倉の天気を調べて、雨なら15分後にタイマーをかけて",
			steps: [
				{
					id: "weather",
					bundle: "weather.forecast",
					task: "明日の鎌倉の天気を調べる",
					from: ["request"],
					result: "明日の鎌倉の天気",
				},
				{
					id: "timer",
					bundle: "timers.manage",
					task: "天気が雨なら15分のタイマーを開始する",
					from: ["request", "weather"],
					result: "開始したタイマー、または開始しなかった理由",
				},
			],
			output: {
				from: ["weather", "timer"],
				deliver: "天気とタイマーの状態を伝える",
			},
		},
	},
	{
		id: "explicit-entry",
		note: "a bundle with two entries, chosen explicitly with `entry`",
		definition: {
			request: "今のタブで検索ボタンを押して",
			steps: [
				{
					id: "operate",
					bundle: "browser.capture",
					entry: "browser.operate",
					task: "今のタブで検索ボタンを押す",
					from: ["request"],
					result: "操作の結果",
				},
			],
			output: { from: ["operate"], deliver: "操作の結果を伝える" },
		},
	},
];

const step = (id: string, bundle: string, from: string[], extra = {}) => ({
	id,
	bundle,
	task: "作業",
	from,
	result: "結果",
	...extra,
});
const def = (steps: unknown[], outputFrom = ["a"]) => ({
	request: "依頼",
	steps,
	output: { from: outputFrom, deliver: "提示する" },
});

export const INVALID: InvalidFixture[] = [
	{
		id: "unknown-component",
		note: "a made-up bundle name (plan §3 illustrative id)",
		expect: "unknown_component",
		definition: def([step("a", "image-generation", ["request"])]),
	},
	{
		id: "reserved-id",
		note: "`request` used as a step id",
		expect: "reserved_id",
		definition: def(
			[step("request", "compute.python", ["request"])],
			["request"],
		),
	},
	{
		id: "duplicate-id",
		note: "two steps with one id",
		expect: "duplicate_id",
		definition: def([
			step("a", "compute.python", ["request"]),
			step("a", "compute.python", ["request"]),
		]),
	},
	{
		id: "forward-reference",
		note: "a step using a later step",
		expect: "forward_reference",
		definition: def(
			[
				step("a", "compute.python", ["b"]),
				step("b", "compute.python", ["request"]),
			],
			["b"],
		),
	},
	{
		id: "self-reference",
		note: "a step using itself (the only cycle a serial plan can express)",
		expect: "self_reference",
		definition: def([step("a", "compute.python", ["a"])]),
	},
	{
		id: "unknown-reference",
		note: "`from` names no step",
		expect: "unknown_reference",
		definition: def([step("a", "compute.python", ["nothing"])]),
	},
	{
		id: "excluded-entry",
		note: "a session/pipeline entry is never offered",
		expect: "component_not_offered",
		definition: def([step("a", "pipeline.studio", ["request"])]),
	},
	{
		id: "ambiguous-bundle",
		note: "a bundle with two offered entries and no `entry`",
		expect: "ambiguous_entry",
		definition: def([step("a", "terminals-screen", ["request"])]),
	},
	{
		id: "entry-not-in-bundle",
		note: "`entry` from another bundle",
		expect: "entry_not_in_bundle",
		definition: def([
			step("a", "cli", ["request"], { entry: "compute.python" }),
		]),
	},
	{
		id: "extra-field",
		note: "an expression smuggled into a step",
		expect: "schema",
		definition: def([
			step("a", "compute.python", ["request"], { code: "x => x + 1" }),
		]),
	},
	{
		id: "no-steps",
		note: "an empty plan must not pass as success",
		expect: "schema",
		definition: def([], ["request"]),
	},
];
