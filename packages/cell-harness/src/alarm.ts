/**
 * The cell's one celld alarm, kept equal to the earliest durable wake time (wake-times.ts).
 * The alarm only wakes the cell; opening the harness resumes every due task from its checkpoint.
 *
 * - `rearm()` sets the alarm only when the computed time differs from `getAlarm()`, because each
 *   install waits for a durable wake entry in the bucket (source: .scratch/sources/git/celld tag
 *   v0.6.1, docs/services/durable-objects.md:133-142). A liveness wake (live work with no timer)
 *   is renewed only when the stored alarm has passed or is later than it, so a running job costs
 *   about one install a minute, not one per poll.
 * - `report()` reads `getAlarm()` before anything else and never re-arms, so `check:alarms` sees a
 *   missing or late alarm as it is.
 * - `settle()` keeps an event busy while due or untimed work runs and re-arms as it goes. It has no
 *   ceiling on the work: when the event ends first, the liveness alarm brings the cell back.
 */
import type { CelldAlarmInfo, CelldAlarmStorage } from "@secbot/cell-storage";
import { logEvent } from "./cell-parts.ts";
import { earliestTimer, type NextWake, type WakeSummary } from "./wake-times.ts";

export interface WakeSource {
  wakes(): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }>;
}

export type AlarmProblem = "no next alarm" | "alarm mismatch";

export interface AlarmReport {
  readonly cell: string;
  readonly ok: boolean;
  /** The stored alarm, ISO 8601, or null. */
  readonly alarm: string | null;
  /** The earliest stored timer, ISO 8601, or null when the cell has none. */
  readonly earliest: string | null;
  readonly earliestSource: string | null;
  readonly problem?: AlarmProblem;
}

const iso = (at: number | null | undefined) =>
  at === null || at === undefined ? null : new Date(at).toISOString();

/** The `check:alarms` verdict for one cell. Pure. */
export function alarmVerdict(
  cell: string,
  alarm: number | null,
  summary: WakeSummary,
): AlarmReport {
  const earliest = earliestTimer(summary);
  const base = {
    cell,
    alarm: iso(alarm),
    earliest: iso(earliest?.at),
    earliestSource: earliest?.source ?? null,
  };
  if (earliest === undefined && summary.liveUntimed === 0) return { ...base, ok: true };
  if (alarm === null) return { ...base, ok: false, problem: "no next alarm" };
  if (earliest !== undefined && alarm > earliest.at) {
    return { ...base, ok: false, problem: "alarm mismatch" };
  }
  return { ...base, ok: true };
}

export interface CellAlarmOptions {
  readonly now?: () => number;
  /** How often `settle()` looks at the tasks; 2 s in a cell. */
  readonly pollMs?: number;
  /** Longest single `settle()`; the liveness alarm covers anything longer. */
  readonly settleLimitMs?: number;
}

export class CellAlarm {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly settleLimitMs: number;
  private chain: Promise<void> = Promise.resolve();
  private settling: Promise<void> | undefined;

  constructor(
    private readonly storage: CelldAlarmStorage,
    private readonly cell: string,
    options: CellAlarmOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 2_000;
    this.settleLimitMs = options.settleLimitMs ?? 15 * 60_000;
  }

  /** Sets the alarm from the current checkpoints. Calls run one after another. */
  rearm(source: WakeSource): Promise<void> {
    const run = this.chain.then(() => this.rearmNow(source));
    this.chain = run.catch(() => {});
    return run;
  }

  private async rearmNow(source: WakeSource): Promise<void> {
    const { next } = await source.wakes();
    const previous = await this.storage.getAlarm();
    if (next === undefined) {
      if (previous !== null) {
        await this.storage.deleteAlarm();
        logEvent("alarm.set", {
          cell: this.cell,
          at: null,
          source: "none",
          previous: iso(previous),
        });
      }
      return;
    }
    if (previous === next.at) return;
    const now = this.now();
    if (next.source === "liveness" && previous !== null && previous > now && previous <= next.at) {
      return;
    }
    await this.storage.setAlarm(next.at);
    logEvent("alarm.set", {
      cell: this.cell,
      at: iso(next.at),
      source: next.source,
      previous: iso(previous),
    });
  }

  /** Read-only: the stored alarm against the earliest stored timer. */
  async report(source: WakeSource): Promise<AlarmReport> {
    const alarm = await this.storage.getAlarm();
    const { summary } = await source.wakes();
    return alarmVerdict(this.cell, alarm, summary);
  }

  /** Logs one alarm wake: when it was due and how late it ran. */
  fired(info: CelldAlarmInfo | undefined, alarmAt: number | undefined): void {
    const scheduled = info?.scheduledTime ?? alarmAt;
    logEvent("alarm.fired", {
      cell: this.cell,
      scheduled_at: iso(scheduled),
      late_ms: scheduled === undefined ? null : Math.max(0, this.now() - scheduled),
      retry_count: info?.retryCount ?? 0,
    });
  }

  /**
   * Resolves once no live task lacks a timer and no timer is due, re-arming on every look; at
   * most `settleLimitMs`. One settle runs at a time; a second call joins it.
   */
  settle(source: WakeSource): Promise<void> {
    if (this.settling === undefined) {
      this.settling = this.settleNow(source).finally(() => {
        this.settling = undefined;
      });
    }
    return this.settling;
  }

  get isSettling(): boolean {
    return this.settling !== undefined;
  }

  private async settleNow(source: WakeSource): Promise<void> {
    const deadline = Date.now() + this.settleLimitMs;
    for (;;) {
      const { summary } = await source.wakes();
      await this.rearm(source);
      const due = summary.wakes.some((wake) => wake.at <= this.now());
      if ((summary.liveUntimed === 0 && !due) || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}
