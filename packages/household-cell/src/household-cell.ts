/**
 * `HouseholdCell`: the one Durable Object named "household". It holds the shared household
 * documents (change-log.ts), which the person cells read and change over celld JS RPC (`read`,
 * `apply`), and it runs the heartbeat routine like every other cell: a minimal pi-durable harness
 * on the same database, with a root conversation, no model, and no tools, so every routine in
 * every cell uses one mechanism (pi-durable tasks with the wake time in the checkpoint) and one
 * alarm check.
 *
 * Snapshots (`snapshot`, `restore`, `wipe`, `digest`) dump and load the whole database, the change
 * log with its operation ids included, so a change replayed after a restore still applies once.
 *
 * RPC on a class that does not extend `DurableObject` needs the `js_rpc` compatibility flag, which
 * the worker configs set (source: .scratch/sources/git/celld tag v0.6.1,
 * crates/celld/js/harness.js:2875-2879 and 5387-5398; docs/cloudflare-compat.md "Compatibility
 * flags").
 */
import type { Harness } from "@earendil-works/pi-durable";
import {
  type AlarmReport,
  alarmVerdict,
  type BudgetBoard,
  type BudgetSettings,
  CellAlarm,
  errorFields,
  HarnessSlot,
  type HeartbeatEnv,
  type HeartbeatState,
  type HouseholdApplyResult,
  type HouseholdChange,
  type HouseholdDocument,
  heartbeatState,
  logEvent,
  type NextWake,
  openRoutineHarness,
  type ReportSpendResult,
  type WakeSummary,
} from "@secbot/cell-harness";
import {
  type CellDump,
  type CelldAlarmInfo,
  type CelldCellStorage,
  type CelldSqliteDatabase,
  CellSnapshots,
  openCelldStorageWithDatabase,
} from "@secbot/cell-storage";
import { BudgetBoardStore } from "./budget-board.ts";
import { ChangeLog, type HistoryEntry } from "./change-log.ts";

export const HOUSEHOLD_CELL_NAME = "household";

export interface HouseholdCellState {
  readonly storage: CelldCellStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface HouseholdCellEnv extends HeartbeatEnv {}

export interface HouseholdCellOptions {
  /** The release version; set by the worker from the bundle. */
  readonly version?: string;
  /** Tests: a clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Tests: the fetch used for heartbeat pings. */
  readonly fetch?: typeof fetch;
  /** Tests: how often a settling alarm looks at the tasks. */
  readonly pollMs?: number;
}

interface Opened {
  readonly log: ChangeLog;
  readonly board: BudgetBoardStore;
  readonly harness: Harness;
  readonly database: CelldSqliteDatabase;
  readonly wakes: () => Promise<{
    readonly summary: WakeSummary;
    readonly next: NextWake | undefined;
  }>;
  /** Logs the count of reports not logged yet, then closes the harness. */
  close(): Promise<void>;
}

export class HouseholdCell {
  /** The routine harness: closed and opened again when celld closes the database under it. */
  private readonly slot: HarnessSlot<Opened>;
  /** The open that `open()` watches for a failure to log. */
  private watched: Promise<Opened> | undefined;
  private readonly alarms: CellAlarm;
  private readonly now: () => number;
  /** Snapshot, restore, wipe, and digest, shared with the person cells. */
  private readonly snapshots: CellSnapshots;

  constructor(
    private readonly state: HouseholdCellState,
    private readonly env: HouseholdCellEnv,
    private readonly options: HouseholdCellOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.alarms = new CellAlarm(state.storage, HOUSEHOLD_CELL_NAME, {
      now: this.now,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    });
    this.snapshots = new CellSnapshots(
      state.storage,
      {
        openDatabase: async () => {
          const opening = this.slot.current();
          return opening === undefined ? undefined : (await opening).database;
        },
        close: () => this.close(),
      },
      this.now,
    );
    // A restore or wipe in progress finishes first, so the harness opens on the new database.
    this.slot = new HarnessSlot(
      HOUSEHOLD_CELL_NAME,
      (onReport) => this.snapshots.idle().then(() => this.openNow(onReport)),
      (work) => this.state.waitUntil?.(work),
    );
  }

  private open(): Promise<Opened> {
    const opening = this.slot.get();
    if (opening !== this.watched) {
      this.watched = opening;
      // A failed open leaves the slot empty, so the next request tries again.
      opening.catch((error: unknown) => {
        logEvent("cell.open_failed", { cell: HOUSEHOLD_CELL_NAME, ...errorFields(error) }, "error");
      });
    }
    return opening;
  }

  private async openNow(onReport: (error: unknown) => void): Promise<Opened> {
    const { storage, database } = await openCelldStorageWithDatabase(this.state.storage);
    const log = new ChangeLog(database, this.now);
    const routine = await openRoutineHarness(
      {
        cell: HOUSEHOLD_CELL_NAME,
        storage,
        env: this.env,
        now: this.now,
        onReport,
        onWakeChange: () => this.rearmSoon(),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      },
      (opened) => this.alarms.rearm(opened),
    );
    return {
      ...routine,
      log,
      board: new BudgetBoardStore(database, this.now),
      database,
    };
  }
  private rearmSoon(): void {
    const opening = this.slot.current();
    if (opening === undefined) return;
    const work = opening
      .then((opened) => this.alarms.rearm(opened))
      .catch((error: unknown) => {
        // The wake path: a cell with no alarm sleeps through its heartbeat, so the failure is logged.
        logEvent(
          "alarm.rearm_failed",
          { cell: HOUSEHOLD_CELL_NAME, ...errorFields(error) },
          "error",
        );
      });
    this.state.waitUntil?.(work);
  }

  /** RPC: the document's live items. */
  async read(document: string): Promise<HouseholdDocument> {
    return (await this.open()).log.read(document);
  }

  /** RPC: applies one single-item change, once per operation id. */
  async apply(change: HouseholdChange): Promise<HouseholdApplyResult> {
    const result = await (await this.open()).log.apply(change);
    logEvent("household.change.applied", {
      document: change.document,
      item_id: result.itemId,
      kind: result.kind,
      from_cell: change.fromCell,
      outcome: result.duplicate ? "duplicate" : result.outcome,
      seq: result.seq,
    });
    return result;
  }

  /** RPC: the document's change log, in order (or one item's). */
  async history(document: string, itemId?: string): Promise<HistoryEntry[]> {
    return (await this.open()).log.history(document, itemId);
  }

  /** RPC: the household budget board (the settings and each cell's newest month report). */
  async budget(): Promise<BudgetBoard> {
    return (await this.open()).board.board();
  }

  /**
   * RPC: a person cell's month report, once per operation id; the answer says which developer
   * alerts that cell sends.
   */
  async reportSpend(report: unknown): Promise<ReportSpendResult> {
    return (await this.open()).board.reportSpend(report);
  }

  /** RPC: the owner changes the household time zone or the developer budget. */
  async setBudget(change: unknown): Promise<BudgetSettings> {
    const settings = await (await this.open()).board.setBudget(change);
    logEvent("budget.settings", {
      time_zone: settings.timeZone,
      developer_limit_usd: settings.developerLimitUsd,
    });
    return settings;
  }

  /** RPC: a claimed developer alert went out, or did not and can be claimed again. */
  async alertSent(outcome: unknown): Promise<void> {
    await (await this.open()).board.alertSent(outcome);
  }

  /** RPC: up with the release version (check:cells). */
  async status(): Promise<{ status: "up"; version: string; roles: string[] }> {
    await this.open();
    return { status: "up", version: this.options.version ?? "0.0.0-dev", roles: [] };
  }

  /**
   * RPC: the stored alarm against the earliest stored timer. Reads the alarm before anything else
   * and never re-arms it itself; waking an evicted cell opens it, and an open re-arms.
   */
  async alarmReport(): Promise<AlarmReport> {
    const alarm = await this.state.storage.getAlarm();
    const opened = await this.open();
    const { summary } = await opened.wakes();
    return alarmVerdict(HOUSEHOLD_CELL_NAME, alarm, summary);
  }

  /** RPC: the whole database as one dump, taken in one transaction. */
  async snapshot(contractStep: number): Promise<CellDump> {
    const dump = await this.snapshots.snapshot(contractStep);
    logEvent("cell.snapshot", { cell: HOUSEHOLD_CELL_NAME, digest: dump.digest, rows: dump.rows });
    return dump;
  }

  /**
   * RPC: replaces the database with `dump`. The routine harness closes first, the load is one
   * transaction checked against the dump's digest, and the reopen re-arms the alarm from the
   * restored checkpoints.
   */
  async restore(dump: CellDump): Promise<{ digest: string; rows: number }> {
    const result = await this.snapshots.restore(dump);
    await this.open();
    logEvent("cell.restored", {
      cell: HOUSEHOLD_CELL_NAME,
      digest: result.digest,
      rows: result.rows,
    });
    return result;
  }

  /** RPC: drops every table and the alarm (the test cell after a restore drill). */
  async wipe(): Promise<void> {
    await this.snapshots.wipe();
    logEvent("cell.wiped", { cell: HOUSEHOLD_CELL_NAME });
  }

  /** RPC: the database digest and row count as they are now. */
  async digest(): Promise<{ digest: string; rows: number }> {
    return this.snapshots.digest();
  }

  /** RPC: the heartbeat routine's last run (check:heartbeats). */
  async heartbeat(): Promise<HeartbeatState> {
    return heartbeatState((await this.open()).harness);
  }

  /** celld's alarm: resume the routines, wait while due work runs, re-arm. */
  async alarm(info?: CelldAlarmInfo): Promise<void> {
    this.alarms.fired(info, undefined);
    const opened = await this.open();
    await this.alarms.settle(opened);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.status());
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Closes the routine harness (before a restore or wipe loads, and in tests). */
  async close(): Promise<void> {
    await this.slot.close();
  }
}
