/**
 * The harness of a cell that runs routines only: a minimal pi-durable harness on the cell's own
 * database, with a root conversation, no model, no tools, and the heartbeat routine. The secrets
 * cell and the household cell both open one, so a fix to how it opens, reports, or closes lands
 * in one place.
 *
 * The first storage-gone report is logged and reaches `onReport` (the cell's `HarnessSlot`, which
 * closes the harness); later ones are counted into one `harness.reports_suppressed` line.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { createHeartbeatRoutine, type HeartbeatEnv } from "./heartbeat.ts";
import { createReportGate } from "./open-harness.ts";
import { ensureRoutines } from "./routines.ts";
import { type NextWake, nextWake, type WakeSummary, wakesOf } from "./wake-times.ts";

export interface RoutineHarness {
  readonly harness: Harness;
  /** The stored wake times and the next one. */
  wakes(): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }>;
  /** Logs the count of reports not logged yet, then closes the harness. */
  close(): Promise<void>;
}

export interface RoutineHarnessOptions {
  readonly cell: string;
  /** The cell's pi-durable storage. */
  readonly storage: Parameters<typeof Harness.open>[0];
  readonly env: HeartbeatEnv;
  readonly now: () => number;
  /** Every harness report, after it is logged or counted. */
  readonly onReport: (error: unknown) => void;
  /** A routine's wake time changed: the cell re-arms its alarm. */
  readonly onWakeChange: () => void;
  /** The fetch for heartbeat pings. */
  readonly fetch?: typeof fetch;
  readonly context?: Context;
}

/**
 * Opens the routine harness, then runs `ready` (for example the alarm's re-arm) on it. When
 * anything fails after the harness opened, the harness is closed before the error is thrown, so it
 * never keeps running while the next event opens another one.
 */
export async function openRoutineHarness(
  options: RoutineHarnessOptions,
  ready: (opened: RoutineHarness) => Promise<void> = async () => {},
): Promise<RoutineHarness> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const hooks = { cell: options.cell, onWakeChange: options.onWakeChange };
  const heartbeat = createHeartbeatRoutine(options.env, hooks, options.fetch);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "secbot-routines", tasks: [heartbeat.task] }));
  const reports = createReportGate(options.cell, options.onReport);
  const harness = await Harness.open(
    options.storage,
    { models: createModels(), registry, now: options.now, onReport: reports.report },
    context,
  );
  try {
    await harness.root(context);
    await ensureRoutines(harness, [{ routine: heartbeat }], options.now(), context);
    harness.resume();
    const opened: RoutineHarness = {
      harness,
      wakes: async () => {
        const summary = wakesOf(await harness.inspect(context));
        return { summary, next: nextWake(summary, options.now()) };
      },
      close: async () => {
        // First, so the count goes out even when the close below never finishes.
        reports.flush();
        await harness.close(context);
      },
    };
    await ready(opened);
    return opened;
  } catch (error) {
    reports.flush();
    await harness.close(context).catch(() => {});
    throw error;
  }
}
