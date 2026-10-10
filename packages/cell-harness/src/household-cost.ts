/**
 * The owner's household cost view (`GET /ops/cost` with no person): one row per person, the
 * developer budget, and the month's total. A person this fleet serves reads its own cell's cost
 * now; a person another fleet serves reads as it last reported to the household budget board.
 * The route only reads the cells and the board and replies; the view is built here, next to the
 * cost view it is made of.
 */
import type { BudgetBoard, SpendReport } from "./household-contract.ts";
import { type BudgetLine, budgetLine, type CostView } from "./limits.ts";
import { DEFAULT_DEVELOPER_BUDGET_USD } from "./release-defaults.ts";

/** One person's row in the household view. */
export interface HouseholdCostRow {
  readonly person: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly line: string;
  readonly mode: string;
  readonly modeSince: number | null;
  /** When the row was read: now for this fleet's cells, the report time for another fleet's. */
  readonly asOf: number;
}

export interface HouseholdCostView {
  readonly month: string;
  readonly timeZone: string;
  /** Every row plus the developer budget, rounded to cents. */
  readonly totalUsd: number;
  /** The owner first. */
  readonly persons: readonly HouseholdCostRow[];
  readonly developer: BudgetLine;
}

/** A person's cost from the household board: a cell another fleet serves, as it last reported. */
export function costFromReport(
  report: SpendReport,
  board: BudgetBoard,
): CostView & { readonly asOf: number } {
  const developerLimit = board.settings.developerLimitUsd ?? DEFAULT_DEVELOPER_BUDGET_USD;
  const line = budgetLine(report.spentUsd, report.limitUsd);
  return {
    person: report.cell,
    month: report.month,
    timeZone: report.timeZone,
    resetsAt: 0,
    mode: report.mode,
    modeSince: report.modeSince,
    spentUsd: report.spentUsd,
    limitUsd: report.limitUsd,
    percent: line.percent,
    line: line.line,
    byLayer: report.byLayer,
    byRole: report.byRole,
    hours: {},
    waiting: [],
    developer: budgetLine(board.developerUsd, developerLimit),
    asOf: report.at,
  };
}

/** One row of the household view from a person's cost view. */
export const rowOf = (view: CostView, asOf: number): HouseholdCostRow => ({
  person: view.person,
  spentUsd: view.spentUsd,
  limitUsd: view.limitUsd,
  percent: view.percent,
  line: view.line,
  mode: view.mode,
  modeSince: view.modeSince,
  asOf,
});

/**
 * The household view: the served persons' own views (read now, at `now`), then each other
 * person's newest report of the same month from the board.
 */
export function householdCostView(
  live: readonly CostView[],
  board: BudgetBoard | undefined,
  now: number,
): HouseholdCostView {
  const rows = live.map((view) => rowOf(view, now));
  const first = live[0];
  const month = first?.month ?? board?.reports[0]?.month ?? "";
  for (const report of board?.reports ?? []) {
    if (rows.some((row) => row.person === report.cell) || report.month !== month) continue;
    rows.push(rowOf(costFromReport(report, board as BudgetBoard), report.at));
  }
  rows.sort((a, b) => (a.person === "owner" ? -1 : b.person === "owner" ? 1 : 0));
  // A served cell knows its own developer spend now; the board adds the other fleet's.
  const developer =
    first?.developer ??
    budgetLine(
      board?.developerUsd ?? 0,
      board?.settings.developerLimitUsd ?? DEFAULT_DEVELOPER_BUDGET_USD,
    );
  const totalUsd = rows.reduce((sum, row) => sum + row.spentUsd, 0) + developer.spentUsd;
  return {
    month,
    timeZone: first?.timeZone ?? board?.settings.timeZone ?? "UTC",
    totalUsd: Math.round(totalUsd * 100) / 100,
    persons: rows,
    developer,
  };
}
