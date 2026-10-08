/**
 * Routines: pi-durable background tasks with a timer (carried decision: each routine is a
 * background task with a timer; the cell sets its one alarm to the earliest timer).
 *
 * The durable wake-time store, write side. A routine's checkpoint is `{ phase: "wait", wakeAt }`:
 * it sleeps until `wakeAt` (pi-durable's in-memory `runtime.sleep`), runs its effect, and commits
 * the next `wakeAt` (now + `every`) in the same commit as anything the effect records, or ends
 * when it has no `every`. A routine that is overdue when the cell starts runs once, and its next
 * wake counts from now: no catch-up runs. A crash between the effect and the commit runs the
 * effect again; every effect is safe to repeat (a heartbeat ping, a follow-up input with a fixed
 * request id). Pattern: pi-durable v1.0.3 test/examples/12-tasks.ts and 13-recovery.ts (studied
 * copy .scratch/sources/git/pi tag v1.0.3).
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  type Harness,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { appendRecord } from "./activity.ts";
import type { BudgetWaiter } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import { doneRecord, jobLabel } from "./jobs.ts";
import { ROUTINE_KIND_PREFIX } from "./wake-times.ts";

/** A failed one-off routine (a reminder whose delivery threw) tries again after this long. */
export const ONE_OFF_RETRY_MS = 60_000;

export const ROUTINE_NAME = /^[a-z][a-z0-9-]{1,31}$/;

export type RoutineInput<P extends JsonObject = JsonObject> = {
  /** The first wake time, epoch milliseconds. */
  readonly wakeAt: number;
  readonly payload: P;
};

export type RoutineState = { phase: "wait"; wakeAt: number };

export interface RoutineFire<P extends JsonObject> {
  readonly cell: string;
  readonly routine: string;
  readonly taskId: TaskId;
  readonly wakeAt: number;
  readonly lateMs: number;
  readonly payload: P;
  readonly runtime: TaskRuntime<RoutineInput<P>, RoutineState, null, object>;
  readonly context: Context;
}

export interface RoutineResult {
  /** Logged as `routine.fired.outcome`. */
  readonly outcome: string;
  /** Writes made in the same commit as the next wake time (exactly once per wake). */
  readonly record?: (tx: Tx) => void | Promise<void>;
}

export interface RoutineSpec<P extends JsonObject> {
  readonly name: string;
  /** Milliseconds between runs; absent for a one-off routine. */
  readonly every?: number;
  /**
   * False for a routine that spends nothing (the heartbeat): it runs above a limit. Every other
   * routine waits above the person's limit before its effect (budget-gate.ts).
   */
  readonly spends?: boolean;
  /** What the waiting list shows for one run; `routine <name>` by default. */
  describe?(payload: P): string;
  run(fire: RoutineFire<P>): Promise<RoutineResult>;
}

export interface RoutineHooks {
  readonly cell: string;
  /** Called after every commit that changes a wake time, so the cell re-arms its alarm. */
  readonly onWakeChange?: () => void;
  /** The cell's budget gate; spending routines wait on it above the person's limit. */
  readonly gate?: () => BudgetWaiter | undefined;
  /**
   * The cell's time zone. When set, each run of a routine that spends leaves one done job record
   * in activity (jobs.ts), in the run's own commit.
   */
  readonly timeZone?: string;
}

export interface Routine<P extends JsonObject = JsonObject> {
  readonly name: string;
  readonly every: number | undefined;
  /** False for a routine that spends nothing (the heartbeat); activity does not list it. */
  readonly spends: boolean;
  readonly task: Task<RoutineInput<P>, RoutineState, null, object>;
}

/** Builds the pi-durable task `secbot.routine:<name>` for one routine. */
export function defineRoutine<P extends JsonObject>(
  spec: RoutineSpec<P>,
  hooks: RoutineHooks,
): Routine<P> {
  if (!ROUTINE_NAME.test(spec.name)) throw new Error(`bad routine name "${spec.name}"`);
  if (spec.every !== undefined && !(spec.every >= 1_000)) {
    throw new Error(`routine ${spec.name}: every must be at least 1000 ms`);
  }
  const what = (payload: P) =>
    spec.describe?.(payload) ?? `routine ${spec.name.replace(/-/g, " ")}`;
  const task = defineTask<RoutineInput<P>, RoutineState, null>({
    name: `${ROUTINE_KIND_PREFIX}${spec.name}`,
    version: 1,
    initial: (input) => ({ phase: "wait", wakeAt: input.wakeAt }),
    phases: {
      wait: async (routine, runtime, context) => {
        const { wakeAt } = routine.state.checkpoint;
        await runtime.sleep(wakeAt, context);
        if (spec.spends !== false) {
          await hooks.gate?.()?.waitUntilUnder(
            {
              budget: "person",
              taskId: String(routine.id),
              what: what(routine.input.payload),
            },
            context,
          );
        }
        const firedAt = runtime.now();
        let result: RoutineResult;
        try {
          result = await spec.run({
            cell: hooks.cell,
            routine: spec.name,
            taskId: routine.id,
            wakeAt,
            lateMs: Math.max(0, firedAt - wakeAt),
            payload: routine.input.payload,
            runtime,
            context,
          });
        } catch (error) {
          // The invocation ended (close, crash): the checkpoint is unchanged, so it runs again.
          if (runtime.signal.aborted) throw error;
          runtime.report(error);
          result = { outcome: "failed" };
        }
        const retry = result.outcome === "failed" && spec.every === undefined;
        const next =
          spec.every !== undefined
            ? runtime.now() + spec.every
            : retry
              ? runtime.now() + ONE_OFF_RETRY_MS
              : undefined;
        await runtime.commit(async (tx) => {
          if (!retry) await result.record?.(tx);
          if (!retry && spec.spends !== false && hooks.timeZone !== undefined) {
            await appendRecord(
              tx,
              doneRecord({
                key: `job:${routine.id}:${wakeAt}`,
                at: firedAt,
                agent: "lead",
                label: jobLabel(what(routine.input.payload)),
                reason:
                  result.outcome === "delivered"
                    ? "delivered to the lead"
                    : result.outcome === "failed"
                      ? "failed"
                      : result.outcome,
                cost: 0,
              }),
              hooks.timeZone,
            );
          }
          return next === undefined
            ? { status: "terminal", outcome: { status: "completed", result: null } }
            : { status: "running", checkpoint: { phase: "wait", wakeAt: next } };
        }, context);
        logEvent("routine.fired", {
          cell: hooks.cell,
          routine: spec.name,
          task_id: routine.id,
          wake_at: new Date(wakeAt).toISOString(),
          late_ms: Math.max(0, firedAt - wakeAt),
          outcome: result.outcome,
          next_wake_at: next === undefined ? null : new Date(next).toISOString(),
        });
        hooks.onWakeChange?.();
      },
    },
    abort: (_routine, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  return { name: spec.name, every: spec.every, spends: spec.spends !== false, task };
}

/** Creates one routine task, owned by the root conversation in the background. */
export function createRoutineTask<P extends JsonObject>(
  tx: Tx,
  routine: Routine<P>,
  wakeAt: number,
  payload: P,
): Promise<TaskId<null>> {
  return tx.createTask(
    routine.task,
    { wakeAt, payload },
    { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
  );
}

/** `secbot.routines`: the task of each recurring routine, by routine name. */
export const RoutinesDoc = defineDoc<{ tasks: Record<string, TaskId> }>({
  kind: "secbot.routines",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: {} }),
});

const LIVE = new Set(["pending", "running", "waiting"]);

/**
 * Creates each recurring routine's task once (first wake: now + `firstWakeMs`, default its
 * `every`), and again when its task ended (aborted or faulted). Idempotent. Returns the names
 * created. The root conversation must exist.
 */
export async function ensureRoutines(
  harness: Harness,
  routines: readonly { readonly routine: Routine; readonly firstWakeMs?: number }[],
  now: number,
  context: Context,
): Promise<string[]> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(RoutinesDoc);
    const created: string[] = [];
    for (const { routine, firstWakeMs } of routines) {
      if (routine.every === undefined) continue;
      const existing = Object.hasOwn(doc.tasks, routine.name) ? doc.tasks[routine.name] : undefined;
      if (existing !== undefined) {
        const record = await tx.task(existing);
        if (record !== undefined && LIVE.has(record.state.status)) continue;
      }
      doc.tasks[routine.name] = await createRoutineTask(
        tx,
        routine,
        now + (firstWakeMs ?? routine.every),
        {} as JsonObject,
      );
      created.push(routine.name);
    }
    return created;
  }, context);
}

/** The JSON-safe view of a routine's checkpoint, for status routes and tests. */
export function routineWake(checkpoint: JsonValue | undefined): number | undefined {
  if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return undefined;
  }
  const wakeAt = (checkpoint as Record<string, JsonValue>).wakeAt;
  return typeof wakeAt === "number" ? wakeAt : undefined;
}
