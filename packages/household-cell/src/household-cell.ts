/**
 * `HouseholdCell`: the one Durable Object named "household". It holds the shared household
 * documents (change-log.ts), which the person cells read and change over celld JS RPC (`read`,
 * `apply`), and it runs the heartbeat routine like every other cell: a minimal pi-durable harness
 * on the same database, with a root conversation, no model, and no tools, so every routine in
 * every cell uses one mechanism (pi-durable tasks with the wake time in the checkpoint) and one
 * alarm check.
 *
 * RPC on a class that does not extend `DurableObject` needs the `js_rpc` compatibility flag, which
 * the worker configs set (source: .scratch/sources/git/celld tag v0.6.1,
 * crates/celld/js/harness.js:2875-2879 and 5387-5398; docs/cloudflare-compat.md "Compatibility
 * flags").
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import {
  type AlarmReport,
  alarmVerdict,
  CellAlarm,
  createHeartbeatRoutine,
  ensureRoutines,
  type HeartbeatEnv,
  type HouseholdApplyResult,
  type HouseholdChange,
  type HouseholdDocument,
  logEvent,
  type NextWake,
  nextWake,
  type WakeSummary,
  wakesOf,
} from "@secbot/cell-harness";
import {
  type CelldAlarmInfo,
  type CelldCellStorage,
  openCelldStorageWithDatabase,
} from "@secbot/cell-storage";
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
  readonly harness: Harness;
  readonly wakes: () => Promise<{
    readonly summary: WakeSummary;
    readonly next: NextWake | undefined;
  }>;
}

export class HouseholdCell {
  private opening: Promise<Opened> | undefined;
  private readonly alarms: CellAlarm;
  private readonly now: () => number;

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
  }

  private open(): Promise<Opened> {
    if (this.opening === undefined) {
      this.opening = this.openNow();
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async openNow(context: Context = BACKGROUND_CONTEXT): Promise<Opened> {
    const { storage, database } = await openCelldStorageWithDatabase(this.state.storage);
    const log = new ChangeLog(database, this.now);
    const hooks = { cell: HOUSEHOLD_CELL_NAME, onWakeChange: () => this.rearmSoon() };
    const heartbeat = createHeartbeatRoutine(this.env, hooks, this.options.fetch);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "secbot-routines", tasks: [heartbeat.task] }));
    const harness = await Harness.open(
      storage,
      {
        models: createModels(),
        registry,
        now: this.now,
        onReport: (error) =>
          logEvent("harness.report", {
            cell: HOUSEHOLD_CELL_NAME,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          }),
      },
      context,
    );
    await harness.root(context);
    await ensureRoutines(harness, [{ routine: heartbeat }], this.now(), context);
    harness.resume();
    const opened: Opened = {
      log,
      harness,
      wakes: async () => {
        const summary = wakesOf(await harness.inspect(context));
        return { summary, next: nextWake(summary, this.now()) };
      },
    };
    await this.alarms.rearm(opened);
    return opened;
  }

  private rearmSoon(): void {
    const opening = this.opening;
    if (opening === undefined) return;
    const work = opening.then((opened) => this.alarms.rearm(opened)).catch(() => {});
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

  /** Tests: closes the routine harness. */
  async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) await (await opening).harness.close(context);
  }
}
