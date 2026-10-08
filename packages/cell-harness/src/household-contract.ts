/**
 * The household contract: the shapes a person cell and the household cell exchange over RPC (a
 * document, its items, one single-item change, the result of applying it) and the name rules both
 * sides check. It has no imports, so the household cell, the person cell's tools, and any client
 * use one definition.
 */

/** A cell name: owner, second, household, and later cells. */
export const CELL_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const HOUSEHOLD_DOCUMENT = /^[a-z][a-z0-9-]{0,31}$/;
export const DEFAULT_HOUSEHOLD_DOCUMENT = "list";

export interface HouseholdItem {
  readonly itemId: string;
  readonly text: string;
  readonly done: boolean;
  readonly version: number;
  /** The change-log position of the change that last wrote the item. */
  readonly updatedSeq: number;
}

export interface HouseholdDocument {
  readonly document: string;
  readonly items: readonly HouseholdItem[];
}

interface ChangeBase {
  readonly opId: string;
  readonly document: string;
  readonly fromCell: string;
}

export type HouseholdChange =
  | (ChangeBase & { readonly kind: "add"; readonly text: string })
  | (ChangeBase & {
      readonly kind: "edit";
      readonly itemId: string;
      readonly text?: string;
      readonly done?: boolean;
    })
  | (ChangeBase & { readonly kind: "remove"; readonly itemId: string });

export interface HouseholdApplyResult {
  /** `missing`: an edit or remove of an item that does not exist (or was removed). */
  readonly outcome: "applied" | "missing";
  readonly kind: HouseholdChange["kind"];
  readonly itemId: string;
  /** The change's position in the household cell's ordered log. */
  readonly seq: number;
  /** True when this operation id was applied before; nothing changed this time. */
  readonly duplicate: boolean;
}

/** The household's budget settings: the time zone months follow, and the developer budget. */
export interface BudgetSettings {
  /** IANA zone; null until the owner sets one (each cell keeps its own zone meanwhile). */
  readonly timeZone: string | null;
  /** USD a month; null until the owner sets it (the release default applies). */
  readonly developerLimitUsd: number | null;
}

/** One person cell's month, as it reports it to the household budget board. */
export interface SpendReport {
  /** Unique per report: a retried call applies once. */
  readonly opId: string;
  readonly cell: string;
  /** `YYYY-MM` in the month's zone. */
  readonly month: string;
  readonly timeZone: string;
  /** When the cell read its ledger; the board keeps each cell's newest report. */
  readonly at: number;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly mode: string;
  readonly modeSince: number | null;
  readonly byLayer: {
    readonly agent: number;
    readonly decision: number;
    readonly reviewer: number;
  };
  readonly byRole: Readonly<Record<string, number>>;
  /** This cell's own developer spend this month. */
  readonly developerUsd: number;
  readonly developerLimitUsd: number;
  /** Developer budget lines (80, 100) whose owner alert this cell would send. */
  readonly developerLines: readonly number[];
}

/** The board: the settings and each cell's newest report of the newest month. */
export interface BudgetBoard {
  readonly settings: BudgetSettings;
  readonly reports: readonly SpendReport[];
  /** Every cell's developer spend in the newest month the board has. */
  readonly developerUsd: number;
}

/** A developer line's alert: this cell sends it, another cell has it, or it is out already. */
export type BudgetAlertStatus = "yours" | "taken" | "sent";

export interface ReportSpendResult {
  readonly board: BudgetBoard;
  /** The other cells' developer spend in the reported month. */
  readonly othersDeveloperUsd: number;
  readonly alerts: readonly { readonly line: number; readonly status: BudgetAlertStatus }[];
}

/** The outcome of a developer alert this cell claimed. */
export interface BudgetAlertSent {
  readonly month: string;
  readonly budget: "developer";
  readonly limitUsd: number;
  readonly line: number;
  readonly cell: string;
  readonly sent: boolean;
}

/** What a person cell uses to reach the household cell. */
export interface HouseholdClient {
  read(document: string): Promise<HouseholdDocument>;
  apply(change: HouseholdChange): Promise<HouseholdApplyResult>;
  /** The budget board (absent on a client built before it). */
  budget?(): Promise<BudgetBoard>;
  reportSpend?(report: SpendReport): Promise<ReportSpendResult>;
  /** The owner changes a household setting; the answer is the new settings. */
  setBudget?(change: Partial<BudgetSettings>): Promise<BudgetSettings>;
  alertSent?(outcome: BudgetAlertSent): Promise<void>;
}
