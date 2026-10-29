/**
 * The capacity warning: after a job starts or finishes, the cell counts its running jobs against
 * the number it was measured to run at once (the cell's own setting, else the release default).
 * The first time the count passes it, the owner gets one alert and `capacity.passed` is logged;
 * more jobs in the same episode send nothing, and a new episode alerts again only after
 * CAPACITY_REARM_MS since the last alert. The watch never holds a job back, never throws, and the
 * job never waits on the alert.
 */

import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import type { Alerts } from "./alerts.ts";
import { errorFields, logEvent } from "./cell-parts.ts";
import { type Capacity, CapacityDoc, JobBoardDoc } from "./docs.ts";
import { CAPACITY_REARM_MS, MEASURED_CAPACITY } from "./release-defaults.ts";

/** A measured number and when it was measured (epoch ms). */
export interface EffectiveCapacity {
  readonly measured: number;
  readonly at: number;
}

/**
 * The number the warning compares against: the cell's own setting when it has one, else the
 * release default (measured at midnight UTC of its day), else null (no warning).
 */
export function effectiveCapacity(
  doc: Pick<Capacity, "measured" | "at"> | undefined,
  release: { readonly jobs: number; readonly on: string } | null = MEASURED_CAPACITY,
): EffectiveCapacity | null {
  if (doc?.measured != null && doc.at != null) return { measured: doc.measured, at: doc.at };
  if (release === null) return null;
  const at = Date.parse(`${release.on}T00:00:00Z`);
  return Number.isNaN(at) ? null : { measured: release.jobs, at };
}

export interface CapacityWatchParts {
  readonly harness: () => Harness;
  readonly person: string;
  readonly alerts: Pick<Alerts, "sendCapacity">;
  readonly now: () => number;
  /** Tests: the release default (MEASURED_CAPACITY). */
  readonly release?: { readonly jobs: number; readonly on: string } | null;
}

/** Counts the running jobs and opens or closes a capacity episode; see the module comment. */
export async function watchCapacity(parts: CapacityWatchParts, context: Context): Promise<void> {
  try {
    const at = parts.now();
    const passed = await parts.harness().commit(async (tx) => {
      const board = await tx.doc(JobBoardDoc);
      const capacity = await tx.doc(CapacityDoc);
      const effective = effectiveCapacity(
        capacity,
        parts.release === undefined ? MEASURED_CAPACITY : parts.release,
      );
      const running = Object.values(board.jobs).filter((row) => row.status === "running").length;
      if (effective === null || running <= effective.measured) {
        if (capacity.passing) capacity.passing = false;
        return null;
      }
      if (capacity.passing) return null;
      capacity.passing = true;
      const rearmed = capacity.alertedAt === null || at - capacity.alertedAt >= CAPACITY_REARM_MS;
      if (rearmed) capacity.alertedAt = at;
      return { running, measured: effective.measured, alert: rearmed };
    }, context);
    if (passed === null) return;
    logEvent("capacity.passed", {
      cell: parts.person,
      parallel_jobs: passed.running,
      measured: passed.measured,
      alerted: passed.alert,
    });
    // The job never waits on the owner alert; a failed alert is logged by the alert itself.
    if (passed.alert) void parts.alerts.sendCapacity(passed.running, passed.measured);
  } catch (error) {
    logEvent("capacity.watch_failed", { cell: parts.person, ...errorFields(error) }, "warn");
  }
}
