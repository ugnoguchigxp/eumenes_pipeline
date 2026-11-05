/** Append-only reservations shared by all providers and phases of an experiment. */
import type { Database } from "bun:sqlite";
import { canonicalJson } from "../catalog/load.ts";

export const API_BUDGET_SCHEMA = `
CREATE TABLE api_budgets(id TEXT PRIMARY KEY, ceiling_microusd INTEGER NOT NULL CHECK(ceiling_microusd > 0), created_at TEXT NOT NULL);
CREATE TABLE api_budget_events(id INTEGER PRIMARY KEY, budget_id TEXT NOT NULL REFERENCES api_budgets(id), request_id TEXT NOT NULL, event TEXT NOT NULL CHECK(event IN ('reserve','settle')), amount_microusd INTEGER NOT NULL CHECK(amount_microusd >= 0), metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(budget_id,request_id,event));
${["api_budgets", "api_budget_events"].flatMap((t) => ["UPDATE", "DELETE"].map((op) => `CREATE TRIGGER ${t}_${op.toLowerCase()} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'budget evidence is append-only'); END;`)).join("\n")}
CREATE TRIGGER budget_settle_requires_reservation BEFORE INSERT ON api_budget_events WHEN NEW.event='settle' AND NOT EXISTS(SELECT 1 FROM api_budget_events WHERE budget_id=NEW.budget_id AND request_id=NEW.request_id AND event='reserve' AND amount_microusd >= NEW.amount_microusd) BEGIN SELECT RAISE(ABORT, 'settlement exceeds or lacks reservation'); END;
`;

export function apiBudget(db: Database, id: string, ceilingUsd: number) {
	if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 10)
		throw new Error("API budget must be greater than zero and at most 10 USD");
	const ceiling = Math.floor(ceilingUsd * 1_000_000);
	db.query("INSERT OR IGNORE INTO api_budgets VALUES (?,?,?)").run(
		id,
		ceiling,
		new Date().toISOString(),
	);
	const stored = db
		.query<{ ceiling_microusd: number }, [string]>(
			"SELECT ceiling_microusd FROM api_budgets WHERE id=?",
		)
		.get(id);
	if (stored?.ceiling_microusd !== ceiling)
		throw new Error("budget ceiling is already frozen");
	const committed = () =>
		db
			.query<{ total: number }, [string]>(
				`SELECT COALESCE(SUM(COALESCE((SELECT s.amount_microusd FROM api_budget_events s WHERE s.budget_id=r.budget_id AND s.request_id=r.request_id AND s.event='settle'),r.amount_microusd)),0) AS total FROM api_budget_events r WHERE r.budget_id=? AND r.event='reserve'`,
			)
			.get(id)?.total ?? 0;
	const append = (
		requestId: string,
		event: string,
		amount: number,
		metadata: unknown,
	) =>
		db
			.query(
				"INSERT INTO api_budget_events(budget_id,request_id,event,amount_microusd,metadata_json,created_at) VALUES(?,?,?,?,?,?)",
			)
			.run(
				id,
				requestId,
				event,
				amount,
				canonicalJson(metadata),
				new Date().toISOString(),
			);
	return {
		id,
		reserve(upperUsd: number, metadata: unknown): string {
			const amount = Math.ceil(upperUsd * 1_000_000);
			if (!Number.isSafeInteger(amount) || amount <= 0)
				throw new Error("invalid cost reservation");
			return db
				.transaction(() => {
					if (committed() + amount > ceiling)
						throw new Error("API budget exhausted; no request sent");
					const requestId = crypto.randomUUID();
					append(requestId, "reserve", amount, metadata);
					return requestId;
				})
				.immediate();
		},
		settle(requestId: string, upperUsd: number, metadata: unknown) {
			const amount = Math.ceil(upperUsd * 1_000_000);
			if (!Number.isSafeInteger(amount) || amount < 0)
				throw new Error("invalid settlement");
			append(requestId, "settle", amount, metadata);
		},
		status() {
			return {
				budgetId: id,
				ceilingUsd,
				committedCostCeilingUsd: committed() / 1_000_000,
				actualBilledUsd: null,
			};
		},
	};
}
export type ApiBudget = ReturnType<typeof apiBudget>;
