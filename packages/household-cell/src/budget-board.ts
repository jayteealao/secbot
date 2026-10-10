/**
 * The household budget board: the household's budget settings (the time zone months follow, and
 * the developer budget) and each person cell's newest month report. Production runs the person
 * cells in two fleets, so only the household cell sees them all: it sums the developer spend of
 * every cell (the developer budget is one household budget) and lets exactly one cell send each
 * developer alert. It is a report of each cell's own ledger, never the source of a person's limit.
 *
 * The board is its own tables and methods, apart from the household documents, so no agent's
 * household tool can change a budget. Every write is one transaction through the cell's
 * `CelldSqliteDatabase` (the change log's pattern, change-log.ts); a report applies once per
 * operation id. Snapshots dump the whole database, so they carry the board.
 */
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import {
  type BudgetAlertSent,
  type BudgetAlertStatus,
  type BudgetBoard,
  type BudgetSettings,
  CELL_NAME,
  checkAmount,
  type ReportSpendResult,
  type SpendReport,
} from "@secbot/cell-harness";
import { RefusedHouseholdChange } from "./change-log.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_reports (
  cell TEXT NOT NULL,
  month TEXT NOT NULL,
  at INTEGER NOT NULL,
  report TEXT NOT NULL,
  PRIMARY KEY (cell, month)
);
CREATE TABLE IF NOT EXISTS budget_report_ops (
  op_id TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_claims (
  month TEXT NOT NULL,
  budget TEXT NOT NULL,
  limit_usd REAL NOT NULL,
  line INTEGER NOT NULL,
  cell TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (month, budget, limit_usd, line)
);
`;

/** A claimed developer alert with no send after this long was lost; another cell may claim it. */
export const BUDGET_CLAIM_STALE_MS = 20_000;

const OP_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LINES = new Set([80, 100]);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** True for an IANA time zone this runtime knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "" || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Checks a report that arrived over RPC or HTTP; throws `RefusedHouseholdChange`. */
export function validateReport(input: unknown): SpendReport {
  const value = input as Record<string, unknown> | null;
  if (value === null || typeof value !== "object") throw new RefusedHouseholdChange("no report");
  if (typeof value.opId !== "string" || !OP_ID.test(value.opId)) {
    throw new RefusedHouseholdChange("bad operation id");
  }
  if (typeof value.cell !== "string" || !CELL_NAME.test(value.cell)) {
    throw new RefusedHouseholdChange("bad cell name");
  }
  if (typeof value.month !== "string" || !MONTH.test(value.month)) {
    throw new RefusedHouseholdChange("bad month");
  }
  for (const field of ["at", "spentUsd", "limitUsd", "developerUsd", "developerLimitUsd"]) {
    if (!finite(value[field]) || (value[field] as number) < 0) {
      throw new RefusedHouseholdChange(`bad ${field}`);
    }
  }
  const lines = Array.isArray(value.developerLines) ? value.developerLines : [];
  if (!lines.every((line) => LINES.has(line as number))) {
    throw new RefusedHouseholdChange("bad developer lines");
  }
  const layer = (value.byLayer ?? {}) as Record<string, unknown>;
  const byRole: Record<string, number> = {};
  for (const [role, spent] of Object.entries((value.byRole ?? {}) as Record<string, unknown>)) {
    if (CELL_NAME.test(role) && finite(spent)) byRole[role] = spent;
  }
  return {
    opId: value.opId,
    cell: value.cell,
    month: value.month,
    timeZone: isTimeZone(value.timeZone) ? value.timeZone : "UTC",
    at: value.at as number,
    spentUsd: value.spentUsd as number,
    limitUsd: value.limitUsd as number,
    mode: value.mode === "enforce" ? "enforce" : "shadow",
    modeSince: finite(value.modeSince) ? value.modeSince : null,
    byLayer: {
      agent: finite(layer.agent) ? layer.agent : 0,
      decision: finite(layer.decision) ? layer.decision : 0,
      reviewer: finite(layer.reviewer) ? layer.reviewer : 0,
    },
    byRole,
    developerUsd: value.developerUsd as number,
    developerLimitUsd: value.developerLimitUsd as number,
    developerLines: lines as number[],
  };
}

export class BudgetBoardStore {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.database.exec(SCHEMA).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /** The settings and each cell's newest report of the newest month. */
  async board(): Promise<BudgetBoard> {
    await this.init();
    const settings = await this.settings();
    const rows = await this.database.all<{ report: string; month: string }>(
      "SELECT report, month FROM budget_reports ORDER BY cell",
    );
    const reports = rows.map((row) => JSON.parse(row.report) as SpendReport);
    const month = reports.reduce(
      (newest, report) => (report.month > newest ? report.month : newest),
      "",
    );
    const current = reports.filter((report) => report.month === month);
    return {
      settings,
      reports: current,
      developerUsd: current.reduce((sum, report) => sum + report.developerUsd, 0),
    };
  }

  private async settings(): Promise<BudgetSettings> {
    const rows = await this.database.all<{ key: string; value: string }>(
      "SELECT key, value FROM budget_settings",
    );
    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    const limit = value("developerLimitUsd");
    return {
      timeZone: value("timeZone") ?? null,
      developerLimitUsd: limit === undefined ? null : Number(limit),
    };
  }

  /**
   * Keeps a cell's report (the newest per cell and month) once per operation id, and answers for
   * each developer line the cell asks to alert: `yours` (claimed now for this cell), `taken`
   * (another cell claimed it recently), or `sent`.
   */
  async reportSpend(input: unknown): Promise<ReportSpendResult> {
    const report = validateReport(input);
    await this.init();
    const at = this.now();
    const alerts = await this.database.transaction(async (tx) => {
      const prior = await tx.get<{ result: string }>(
        "SELECT result FROM budget_report_ops WHERE op_id = ?",
        report.opId,
      );
      if (prior !== undefined) {
        return JSON.parse(prior.result) as { line: number; status: BudgetAlertStatus }[];
      }
      const kept = await tx.get<{ at: number }>(
        "SELECT at FROM budget_reports WHERE cell = ? AND month = ?",
        report.cell,
        report.month,
      );
      if (kept === undefined || Number(kept.at) <= report.at) {
        await tx.run(
          "INSERT OR REPLACE INTO budget_reports (cell, month, at, report) VALUES (?, ?, ?, ?)",
          report.cell,
          report.month,
          report.at,
          JSON.stringify(report),
        );
      }
      const answers: { line: number; status: BudgetAlertStatus }[] = [];
      for (const line of [...new Set(report.developerLines)].sort((a, b) => a - b)) {
        const claim = await tx.get<{ cell: string; claimed_at: number; sent_at: number | null }>(
          "SELECT cell, claimed_at, sent_at FROM budget_claims WHERE month = ? AND budget = 'developer' AND limit_usd = ? AND line = ?",
          report.month,
          report.developerLimitUsd,
          line,
        );
        if (claim?.sent_at != null) {
          answers.push({ line, status: "sent" });
        } else if (
          claim !== undefined &&
          claim.cell !== report.cell &&
          at - Number(claim.claimed_at) <= BUDGET_CLAIM_STALE_MS
        ) {
          answers.push({ line, status: "taken" });
        } else {
          await tx.run(
            "INSERT OR REPLACE INTO budget_claims (month, budget, limit_usd, line, cell, claimed_at, sent_at) VALUES (?, 'developer', ?, ?, ?, ?, NULL)",
            report.month,
            report.developerLimitUsd,
            line,
            report.cell,
            at,
          );
          answers.push({ line, status: "yours" });
        }
      }
      await tx.run(
        "INSERT INTO budget_report_ops (op_id, result) VALUES (?, ?)",
        report.opId,
        JSON.stringify(answers),
      );
      return answers;
    });
    const board = await this.board();
    const others = board.reports
      .filter((each) => each.cell !== report.cell && each.month === report.month)
      .reduce((sum, each) => sum + each.developerUsd, 0);
    return { board, othersDeveloperUsd: others, alerts };
  }

  /** The claiming cell's send: marks the alert sent, or releases the claim so it can go again. */
  async alertSent(input: unknown): Promise<void> {
    const value = (input ?? {}) as Partial<BudgetAlertSent>;
    if (typeof value.month !== "string" || !MONTH.test(value.month)) {
      throw new RefusedHouseholdChange("bad month");
    }
    if (!finite(value.limitUsd) || !LINES.has(value.line as number)) {
      throw new RefusedHouseholdChange("bad alert line");
    }
    if (typeof value.cell !== "string" || !CELL_NAME.test(value.cell)) {
      throw new RefusedHouseholdChange("bad cell name");
    }
    const { month, limitUsd, line, cell } = value;
    await this.init();
    await this.database.transaction(async (tx) => {
      if (value.sent === true) {
        await tx.run(
          "UPDATE budget_claims SET sent_at = ? WHERE month = ? AND budget = 'developer' AND limit_usd = ? AND line = ? AND cell = ?",
          this.now(),
          month,
          limitUsd,
          line as number,
          cell,
        );
      } else {
        await tx.run(
          "DELETE FROM budget_claims WHERE month = ? AND budget = 'developer' AND limit_usd = ? AND line = ? AND cell = ? AND sent_at IS NULL",
          month,
          limitUsd,
          line as number,
          cell,
        );
      }
    });
  }

  /**
   * The owner changes a household setting: the time zone (from the next month in each cell) or the
   * developer budget (from the next call). Refuses an unknown zone or a bad amount.
   */
  async setBudget(input: unknown): Promise<BudgetSettings> {
    const change = (input ?? {}) as Record<string, unknown>;
    const writes: [string, string][] = [];
    if (change.timeZone !== undefined) {
      if (!isTimeZone(change.timeZone)) {
        throw new RefusedHouseholdChange(
          "the time zone is not an IANA zone, for example Europe/London",
        );
      }
      writes.push(["timeZone", change.timeZone]);
    }
    if (change.developerLimitUsd !== undefined) {
      let amount: number;
      try {
        amount = checkAmount(change.developerLimitUsd);
      } catch (error) {
        throw new RefusedHouseholdChange(error instanceof Error ? error.message : String(error));
      }
      writes.push(["developerLimitUsd", String(amount)]);
    }
    if (writes.length === 0) {
      throw new RefusedHouseholdChange("send timeZone or developerLimitUsd");
    }
    await this.init();
    await this.database.transaction(async (tx) => {
      for (const [key, value] of writes) {
        await tx.run(
          "INSERT OR REPLACE INTO budget_settings (key, value) VALUES (?, ?)",
          key,
          value,
        );
      }
    });
    return this.settings();
  }
}
