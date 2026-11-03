/**
 * Accuracy item 3: union presentation — emb-prefix top-12 ∪ BM25 top-k.
 *
 * The subset presentation (Wave C) was not adopted as the default because
 * emb-prefix top-12 alone misses required entries (holdout containment
 * 88.2%). This module measures, OFFLINE over recorded selection results,
 * whether adding the BM25 leg's top-k as a union recovers those misses and
 * at what presentation growth.
 *
 * The emb-prefix rankings come from the recorded results file (the embedding
 * Provider is never called here). The BM25 leg is a pure function of the
 * case request and the offered cards, so it is recomputed locally with the
 * exact index the experiment / tuning runs use (`createBm25Index` over
 * `cardPassages`). When the recorded file itself carries BM25 rankings
 * (the Wave B dev experiment), the recomputation must reproduce them
 * exactly, case by case, or the analysis refuses to run — that is what
 * makes the recomputed holdout leg trustworthy.
 *
 * The presented set is a superset of emb-prefix top-12 by construction, so
 * containment can only grow; the questions are how much it grows on the
 * holdout split and how many extra cards the prompt has to carry.
 */
import { readFileSync } from "node:fs";
import { cardPassages } from "eumenes_router";
import type { ComponentCard } from "../../src/contracts/component.ts";
import { loadBenchCatalog } from "../catalog/load.ts";
import { loadCases, type EvalCase } from "../cases/cases.ts";
import {
	createBm25Index,
	rankFromScores,
	type EntryRanking,
} from "./experiment.ts";

/** Cards the frozen emb-prefix presentation offers. */
export const UNION_BASE_K = 12;
/** BM25 depths scanned for the union leg. */
export const UNION_BM25_KS = [3, 4, 5, 6] as const;

/**
 * The union presentation: emb-prefix top-`baseK` in ranking order, then the
 * BM25 top-`bm25K` entries not already present, in BM25 order.
 */
export function unionPresented(
	embPrefix: EntryRanking,
	bm25: EntryRanking,
	bm25K: number,
	baseK: number = UNION_BASE_K,
): string[] {
	const presented = embPrefix.slice(0, baseK);
	const seen = new Set(presented);
	for (const entry of bm25.slice(0, bm25K)) {
		if (!seen.has(entry)) {
			presented.push(entry);
			seen.add(entry);
		}
	}
	return presented;
}

/** A case is contained when every required entry is in the presented set. */
export function setContainsAll(
	required: readonly string[],
	presented: readonly string[],
): boolean {
	const set = new Set(presented);
	return required.every((entry) => set.has(entry));
}

type RecordedCase = {
	caseId: string;
	required: string[];
	rankings: Record<string, EntryRanking | undefined>;
};

type RecordedResults = {
	runId: string;
	split: "dev" | "holdout";
	perCase: RecordedCase[];
};

export type UnionCaseResult = {
	caseId: string;
	required: string[];
	/** Required entries missing from emb-prefix top-12. */
	missingFromBase: string[];
	/** Per scanned BM25 depth: whether the union contains the case. */
	containedByK: Record<string, boolean>;
	/** Presented-set size per scanned depth (base depth included as "0"). */
	presentedSizeByK: Record<string, number>;
};

export type UnionDepthMetrics = {
	bm25K: number;
	contained: number;
	evaluated: number;
	rate: number;
	meanPresentedSize: number;
	meanAddedEntries: number;
	/** Mean total cardPassages characters of the added entries (prompt-growth proxy). */
	meanAddedPassageChars: number;
	recoveredCaseIds: string[];
};

export type UnionReport = {
	runId: string;
	startedAt: string;
	split: "dev" | "holdout";
	sourceRunId: string;
	sourceResultsPath: string;
	catalog: { snapshotSha256: string; version: string };
	bm25Validation: { checked: number; mismatches: string[] };
	evaluated: number;
	depths: UnionDepthMetrics[];
	perCase: UnionCaseResult[];
};

function passagesOf(card: ComponentCard): string[] {
	return cardPassages({
		title: card.title,
		summary: card.summary,
		useWhen: card.useWhen,
		examples: [],
	});
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length &&
	[...a].sort().every((v, i) => v === [...b].sort()[i]);

const sameRanking = (a: EntryRanking, b: EntryRanking) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function runUnionAnalysis(options: {
	recordedResultsPath: string;
	casesDir?: string;
}): UnionReport {
	const startedAt = new Date().toISOString();
	const runId = crypto.randomUUID();
	const recorded = JSON.parse(
		readFileSync(options.recordedResultsPath, "utf8"),
	) as RecordedResults;
	if (recorded.split !== "dev" && recorded.split !== "holdout")
		throw new Error(
			`recorded results carry an unknown split: ${String(recorded.split)}`,
		);

	const catalog = loadBenchCatalog({ policy: "ready+partial" });
	try {
		const cards = catalog.cards;
		const entries = cards.map((c) => c.entry);
		const perCard = cards.map((card) => ({
			entry: card.entry,
			passages: passagesOf(card),
		}));
		const passageChars = new Map(
			perCard.map((c) => [
				c.entry,
				c.passages.reduce((sum, p) => sum + p.length, 0),
			]),
		);
		const bm25 = createBm25Index(perCard);

		// The evaluated set is re-derived with the tuning protocol's filter and
		// must match the recorded file exactly; anything else means the inputs
		// drifted and the comparison would be meaningless.
		const splitCases = loadCases(options.casesDir).filter(
			(c) => c.split === recorded.split,
		);
		const evaluated: EvalCase[] = splitCases.filter(
			(c) =>
				c.expected.kind === "pipeline" &&
				(c.expected.requiredBundles ?? []).length > 0,
		);
		const recordedById = new Map(
			recorded.perCase.map((c) => [c.caseId, c] as const),
		);
		if (recordedById.size !== evaluated.length)
			throw new Error(
				`case set mismatch: recorded ${recordedById.size} cases vs re-derived ${evaluated.length}`,
			);

		const validation = { checked: 0, mismatches: [] as string[] };
		const perCase: UnionCaseResult[] = [];
		for (const evalCase of evaluated) {
			const rec = recordedById.get(evalCase.id);
			if (!rec) throw new Error(`recorded results lack case ${evalCase.id}`);
			const required = evalCase.expected.requiredBundles ?? [];
			if (!sameSet(rec.required, required))
				throw new Error(
					`required-set mismatch for ${evalCase.id}: recorded ${rec.required} vs case ${required}`,
				);
			const embPrefix = rec.rankings["emb-prefix"];
			if (!embPrefix)
				throw new Error(
					`recorded results lack the emb-prefix ranking for ${evalCase.id}`,
				);
			const bm25Ranking = rankFromScores(entries, bm25.score(evalCase.request));
			const recordedBm25 = rec.rankings["bm25"];
			if (recordedBm25) {
				validation.checked += 1;
				if (!sameRanking(recordedBm25, bm25Ranking))
					validation.mismatches.push(evalCase.id);
			}
			const base = embPrefix.slice(0, UNION_BASE_K);
			const missingFromBase = required.filter((e) => !base.includes(e));
			const containedByK: Record<string, boolean> = {
				"0": missingFromBase.length === 0,
			};
			const presentedSizeByK: Record<string, number> = {
				"0": base.length,
			};
			for (const k of UNION_BM25_KS) {
				const presented = unionPresented(embPrefix, bm25Ranking, k);
				containedByK[String(k)] = setContainsAll(required, presented);
				presentedSizeByK[String(k)] = presented.length;
			}
			perCase.push({
				caseId: evalCase.id,
				required: [...required],
				missingFromBase,
				containedByK,
				presentedSizeByK,
			});
		}
		if (validation.mismatches.length > 0)
			throw new Error(
				`recomputed BM25 rankings disagree with the recorded ones for: ${validation.mismatches.join(", ")}`,
			);

		// Depths: 0 = emb-prefix alone (the frozen baseline), then each union.
		const depths: UnionDepthMetrics[] = [0, ...UNION_BM25_KS].map((k) => {
			let contained = 0;
			let sizeSum = 0;
			let addedSum = 0;
			let charsSum = 0;
			const recoveredCaseIds: string[] = [];
			for (const evalCase of evaluated) {
				const rec = recordedById.get(evalCase.id);
				const row = perCase.find((r) => r.caseId === evalCase.id);
				if (!rec || !row) throw new Error("internal: case row missing");
				const bm25Ranking = rankFromScores(
					entries,
					bm25.score(evalCase.request),
				);
				const presented = unionPresented(
					rec.rankings["emb-prefix"] as EntryRanking,
					bm25Ranking,
					k,
				);
				if (row.containedByK[String(k)]) contained += 1;
				if (k > 0 && row.containedByK[String(k)] && !row.containedByK["0"])
					recoveredCaseIds.push(evalCase.id);
				sizeSum += presented.length;
				const added = presented.slice(UNION_BASE_K);
				addedSum += added.length;
				charsSum += added.reduce(
					(sum, e) => sum + (passageChars.get(e) ?? 0),
					0,
				);
			}
			const n = evaluated.length;
			return {
				bm25K: k,
				contained,
				evaluated: n,
				rate: n === 0 ? 0 : contained / n,
				meanPresentedSize: n === 0 ? 0 : sizeSum / n,
				meanAddedEntries: n === 0 ? 0 : addedSum / n,
				meanAddedPassageChars: n === 0 ? 0 : charsSum / n,
				recoveredCaseIds,
			};
		});

		return {
			runId,
			startedAt,
			split: recorded.split,
			sourceRunId: recorded.runId,
			sourceResultsPath: options.recordedResultsPath,
			catalog: {
				snapshotSha256: catalog.snapshot.sha256,
				version: catalog.view.version,
			},
			bm25Validation: validation,
			evaluated: evaluated.length,
			depths,
			perCase,
		};
	} finally {
		catalog.close();
	}
}

/** One-line-per-depth rendering for the CLI and the run record. */
export function renderUnionSummary(report: UnionReport): string {
	const lines = [
		`# selection union presentation (emb-prefix top-${UNION_BASE_K} ∪ bm25 top-k)`,
		``,
		`- split: ${report.split}（pipeline ケース ${report.evaluated} 件）`,
		`- source run: ${report.sourceRunId}（${report.sourceResultsPath}）`,
		`- bm25 再計算の検証: recorded と照合 ${report.bm25Validation.checked} 件、不一致 ${report.bm25Validation.mismatches.length} 件`,
		``,
		`| bm25 k | 含有 | 含有率 | 平均提示件数 | 平均追加 | 平均追加文字数 | 回復ケース |`,
		`| ---: | ---: | ---: | ---: | ---: | ---: | --- |`,
		...report.depths.map(
			(d) =>
				`| ${d.bm25K} | ${d.contained}/${d.evaluated} | ${(d.rate * 100).toFixed(1)}% | ${d.meanPresentedSize.toFixed(2)} | ${d.meanAddedEntries.toFixed(2)} | ${Math.round(d.meanAddedPassageChars)} | ${d.recoveredCaseIds.join(", ") || "—"} |`,
		),
	];
	return lines.join("\n") + "\n";
}
