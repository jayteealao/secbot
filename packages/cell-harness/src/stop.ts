/**
 * The stop command: it halts every unfinished job of the person and the lead's current turn, and
 * keeps their state for a later restart. Routines and reminders keep their schedule.
 *
 * The stop runs in three moves. First, one commit sets the dispatch lock (no job starts, restarts,
 * or resumes while it is set: each of those reads the lock in its own commit) and marks every
 * unfinished job that has a live task. Then each marked job task is aborted by id (its abort ends
 * the row `stopped` with its brief, transcript, and cost) and the lead's turn is aborted without
 * crossing background boundaries, so routines, reminders, a finished job's wake, a result review,
 * and a background tool call all keep running. Last, one commit lifts the lock and records the
 * stop. Abort withdraws queued inputs; every brief and pending answer is on the board.
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { type Conversation, type Harness, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { ENDED, JobBoardDoc, type JobStop, StopDoc } from "./docs.ts";

export interface StopParts {
  readonly harness: Harness;
  /** The lead's conversation: its current turn stops. */
  readonly root: Conversation;
  readonly person: string;
  readonly now: () => number;
}

/** What one stop stopped: how many jobs, and whether the lead was in a turn. */
export type StopAnswer = { readonly jobs: number; readonly turn: boolean };

export interface StopSeams {
  /** Test-only: runs after the lock is set and before any abort. */
  readonly afterLock?: () => Promise<void>;
}

/** The refusal a job start, restart, or resume gets while a stop runs. */
export const STOP_RUNNING = "Everything is being stopped; start it again once the stop is done.";

export async function stopJobs(
  parts: StopParts,
  by: JobStop["by"],
  context: Context,
  seams: StopSeams = {},
): Promise<StopAnswer> {
  const { harness, root, person } = parts;
  const at = parts.now();
  const started = Date.now();
  const turn = (await harness.snapshot(LiveDoc, root.id, context))?.run !== undefined;
  const marked = await harness.commit(async (tx) => {
    (await tx.doc(StopDoc)).active = { at, by };
    const board = await tx.doc(JobBoardDoc);
    const jobs: { number: number; taskId: TaskId }[] = [];
    for (const row of Object.values(board.jobs)) {
      if (ENDED.has(row.status) || row.taskId === null) continue;
      const task = await tx.task(row.taskId);
      if (task === undefined || task.state.status === "terminal") continue;
      row.stop = { at, by };
      jobs.push({ number: row.number, taskId: row.taskId });
    }
    return jobs;
  }, context);
  await seams.afterLock?.();
  const quiet = withoutAbortSignal(context);
  for (const job of marked) await harness.abortTask(job.taskId, quiet);
  // Not `background: true`: that would also abort routines, reminders, and reviews.
  await root.abort(quiet);
  for (const job of marked) await harness.waitForTask(job.taskId, quiet);
  const left = await harness.commit(async (tx) => {
    const stop = await tx.doc(StopDoc);
    stop.active = null;
    stop.last = { at, by, jobs: marked.length, turn };
    const board = await tx.doc(JobBoardDoc);
    const running: number[] = [];
    for (const job of marked) {
      const row = board.jobs[String(job.number)];
      if (row === undefined || row.status === "stopped") continue;
      // A job whose task ended it some other way keeps that end, not the stop mark.
      row.stop = null;
      if (!ENDED.has(row.status)) running.push(job.number);
    }
    return running;
  }, quiet);
  for (const job of marked) {
    if (!left.includes(job.number)) logEvent("job.stopped", { cell: person, job: job.number, by });
  }
  if (left.length > 0) logEvent("stop.left_running", { cell: person, jobs: left.length }, "warn");
  logEvent("stop.done", {
    cell: person,
    by,
    jobs: marked.length,
    turn,
    duration_ms: Date.now() - started,
  });
  return { jobs: marked.length, turn };
}
