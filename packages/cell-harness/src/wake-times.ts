/**
 * The durable wake-time store, read side. pi-durable has no next-wake API and waits in memory
 * (`runtime.sleep` is a `setTimeout`; source: node_modules/@earendil-works/pi-durable/dist/harness/
 * scheduler.js:1066-1080), so a crash or an eviction loses every pending wait. Every wake time a
 * cell needs is in a durable task checkpoint instead, which `harness.inspect()` returns:
 * - a routine's `wakeAt` (routines.ts);
 * - a generation retry's `until` and a deferred generation's `pollAt`
 *   (dist/harness/generation.js:124-141, 320-330, 370-380, task "pi.generation");
 * - a compaction retry's `until` (dist/harness/compaction.js:137-159, task "pi.compaction").
 * The cell sets its one celld alarm from these records only; nothing here keeps a timer list.
 *
 * Work waiting above a spending limit (budget-gate.ts) is listed in `secbot.budget-waits`; such a
 * task is timed at the month reset (kind `budget`) in place of its own past wake time, so the cell
 * does not wake every minute for weeks. A raised limit wakes it through the owner's route.
 */
import type { HarnessInspection } from "@earendil-works/pi-durable";

/** Routine tasks are named `secbot.routine:<name>`. */
export const ROUTINE_KIND_PREFIX = "secbot.routine:";

/** How far ahead the cell wakes itself while live work without a timer runs (a model call, a job). */
export const LIVENESS_WAKE_MS = 60_000;

export type WakeKind = "routine" | "model-retry" | "model-poll" | "compaction-retry" | "budget";

/** Tasks waiting above a limit, and when the month resets. */
export interface BudgetWaits {
  readonly taskIds: ReadonlySet<string>;
  readonly resetsAt: number;
}

export interface Wake {
  readonly taskId: string;
  readonly kind: WakeKind;
  /** The routine's name, or the task kind. */
  readonly source: string;
  readonly at: number;
}

export interface NextWake {
  readonly at: number;
  /** What set it: a routine name, a task kind, or "liveness". */
  readonly source: string;
}

export interface WakeSummary {
  readonly wakes: readonly Wake[];
  /** Live tasks with no timer of their own: running, ready, or waiting on other tasks. */
  readonly liveUntimed: number;
}

const numberAt = (checkpoint: Record<string, unknown>, field: string): number | undefined => {
  const value = checkpoint[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/** Reads every wake time from the live tasks' durable checkpoints. Pure. */
export function wakesOf(
  inspection: Pick<HarnessInspection, "tasks">,
  waits?: BudgetWaits,
): WakeSummary {
  const wakes: Wake[] = [];
  let liveUntimed = 0;
  for (const { record, state } of inspection.tasks) {
    // A task no definition can take never runs; waking the cell for it would loop.
    if (state.kind === "blocked" || state.kind === "completing") continue;
    const checkpoint =
      record.state.status === "terminal" || record.state.status === "completing"
        ? undefined
        : (record.state.checkpoint as Record<string, unknown> | null);
    const taskId = String(record.id);
    let wake: Wake | undefined;
    if (waits?.taskIds.has(taskId) === true && checkpoint !== undefined) {
      wake = { taskId, kind: "budget", source: "budget", at: waits.resetsAt };
    } else if (checkpoint !== undefined && checkpoint !== null) {
      if (record.kind.startsWith(ROUTINE_KIND_PREFIX)) {
        const at = numberAt(checkpoint, "wakeAt");
        if (at !== undefined) {
          wake = {
            taskId,
            kind: "routine",
            source: record.kind.slice(ROUTINE_KIND_PREFIX.length),
            at,
          };
        }
      } else if (record.kind === "pi.generation" && checkpoint.phase === "retry") {
        const at = numberAt(checkpoint, "until");
        if (at !== undefined) wake = { taskId, kind: "model-retry", source: record.kind, at };
      } else if (record.kind === "pi.generation" && checkpoint.phase === "poll") {
        const at = numberAt(checkpoint, "pollAt");
        if (at !== undefined) wake = { taskId, kind: "model-poll", source: record.kind, at };
      } else if (record.kind === "pi.compaction" && checkpoint.phase === "retry") {
        const at = numberAt(checkpoint, "until");
        if (at !== undefined) wake = { taskId, kind: "compaction-retry", source: record.kind, at };
      }
    }
    if (wake === undefined) liveUntimed++;
    else wakes.push(wake);
  }
  wakes.sort((a, b) => a.at - b.at);
  return { wakes, liveUntimed };
}

/**
 * The cell's next alarm: the earliest stored wake time, or `now + LIVENESS_WAKE_MS` when live work
 * without a timer exists and no timer is sooner, so a crashed or evicted cell comes back to finish
 * it. Never later than the earliest stored wake time. Undefined when nothing is due ever.
 */
export function nextWake(summary: WakeSummary, now: number): NextWake | undefined {
  const earliest = summary.wakes[0];
  const liveness = summary.liveUntimed > 0 ? now + LIVENESS_WAKE_MS : undefined;
  if (earliest === undefined) {
    return liveness === undefined ? undefined : { at: liveness, source: "liveness" };
  }
  if (liveness !== undefined && liveness < earliest.at) return { at: liveness, source: "liveness" };
  return { at: earliest.at, source: earliest.source };
}

/** The earliest stored timer alone (what `check:alarms` compares the alarm against). */
export function earliestTimer(summary: WakeSummary): Wake | undefined {
  return summary.wakes[0];
}
