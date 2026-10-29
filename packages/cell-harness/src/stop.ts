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
import { errorFields, logEvent, syncFailed } from "./cell-parts.ts";
import { ENDED, JobBoardDoc, type JobRow, type JobStop, StopDoc } from "./docs.ts";

export interface StopParts {
  readonly harness: Harness;
  /** The lead's conversation: its current turn stops. */
  readonly root: Conversation;
  readonly person: string;
  readonly now: () => number;
  /**
   * A person cell's shared jobs: the stop sends the household one stop of every joined shared job
   * the person is part of, and runs one bounded exchange before it answers. Undefined in a cell
   * with no household, and in the household itself.
   */
  readonly shared?: {
    readonly opId: () => string;
    readonly sync: (context: Context) => Promise<unknown>;
  };
}

/**
 * What one stop stopped: how many jobs, whether the lead was in a turn, and how many aborted jobs
 * had not ended by the stop's bound (absent when none): those are not counted in `jobs`, and a
 * second stop shows whether they ended.
 */
export type StopAnswer = {
  readonly jobs: number;
  readonly turn: boolean;
  readonly running?: number;
};

export interface StopSeams {
  /** Test-only: runs after the lock is set and before any abort. */
  readonly afterLock?: () => Promise<void>;
}

/** The refusal a job start, restart, or resume gets while a stop runs. */
export const STOP_RUNNING = "Everything is being stopped; start it again once the stop is done.";

/** How long a stop waits for its aborted jobs to end before it lifts the lock. */
export const STOP_WAIT_MS = 15_000;

/** Waits for `work`, or for `ms`, whichever comes first. */
async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopJobs(
  parts: StopParts,
  by: JobStop["by"],
  context: Context,
  seams: StopSeams = {},
  /** Only the rows this picks (one person's shared jobs in the household); default every row. */
  select: (row: JobRow) => boolean = () => true,
): Promise<StopAnswer> {
  const { harness, root, person } = parts;
  const at = parts.now();
  const started = Date.now();
  const turn = (await harness.snapshot(LiveDoc, root.id, context))?.run !== undefined;
  const locked = await harness.commit(async (tx) => {
    (await tx.doc(StopDoc)).active = { at, by };
    const board = await tx.doc(JobBoardDoc);
    const jobs: { number: number; taskId: TaskId }[] = [];
    // A joined shared job runs in the household: one stop op asks it to stop them all. An offer
    // nobody joined has nothing running and stays as it is. The owner's stop of everything reaches
    // the household itself, which stops and counts its shared jobs, so it sends no op here.
    const shared = Object.values(board.jobs).filter(
      (row) =>
        by !== "owner" &&
        parts.shared !== undefined &&
        row.shared !== null &&
        row.shared.household !== null &&
        row.shared.consent === "joined" &&
        !ENDED.has(row.status),
    );
    if (parts.shared !== undefined && shared[0]?.shared) {
      shared[0].shared.outbox.push({ kind: "stop", opId: parts.shared.opId(), person });
    }
    for (const row of Object.values(board.jobs)) {
      if (ENDED.has(row.status) || row.taskId === null || !select(row)) continue;
      const task = await tx.task(row.taskId);
      if (task === undefined || task.state.status === "terminal") continue;
      row.stop = { at, by };
      jobs.push({ number: row.number, taskId: row.taskId });
    }
    return { jobs, shared: shared.length };
  }, context);
  const marked = locked.jobs;
  const count = marked.length + locked.shared;
  await seams.afterLock?.();
  const quiet = withoutAbortSignal(context);
  // Each move runs whatever the one before it did: a failed job abort skips neither the lead
  // turn's abort nor the wait, and the lock is lifted below whatever an abort did (a lock left set
  // would refuse every later start, restart, and resume until another stop).
  const aborts = await Promise.allSettled(
    marked.map((job) => harness.abortTask(job.taskId, quiet)),
  );
  aborts.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      logEvent(
        "stop.abort_failed",
        { cell: person, job: marked[index]?.number ?? null, ...errorFields(outcome.reason) },
        "warn",
      );
    }
  });
  try {
    // Not `background: true`: that would also abort routines, reminders, and reviews.
    await root.abort(quiet);
  } catch (error) {
    logEvent("stop.abort_failed", { cell: person, job: null, ...errorFields(error) }, "warn");
  }
  // A job that has not ended by the bound is counted as left running below.
  await within(
    STOP_WAIT_MS,
    Promise.allSettled(
      marked
        .filter((_, index) => aborts[index]?.status === "fulfilled")
        .map((job) =>
          harness.waitForTask(job.taskId, quiet).catch((error: unknown) => {
            // A failed wait is told apart from a slow job; the job is still counted as left running.
            logEvent(
              "stop.wait_failed",
              { cell: person, job: job.number, ...errorFields(error) },
              "warn",
            );
          }),
        ),
    ),
  );
  const left = await harness.commit(async (tx) => {
    const stop = await tx.doc(StopDoc);
    stop.active = null;
    const board = await tx.doc(JobBoardDoc);
    const running: number[] = [];
    for (const job of marked) {
      const row = board.jobs[String(job.number)];
      if (row === undefined || row.status === "stopped") continue;
      // A job whose task ended it some other way keeps that end, not the stop mark.
      row.stop = null;
      if (!ENDED.has(row.status)) running.push(job.number);
    }
    // What it stopped, as the answer says: a job still ending is not counted.
    stop.last = { at, by, jobs: count - running.length, turn };
    return running;
  }, quiet);
  for (const job of marked) {
    if (!left.includes(job.number)) logEvent("job.stopped", { cell: person, job: job.number, by });
  }
  if (left.length > 0) logEvent("stop.left_running", { cell: person, jobs: left.length }, "warn");
  const stopped = count - left.length;
  // Bounded by the exchange's own timeout; an unanswered household keeps the op for the next one.
  if (locked.shared > 0) await parts.shared?.sync(quiet).catch(syncFailed(person));
  logEvent("stop.done", {
    cell: person,
    by,
    jobs: stopped,
    running: left.length,
    turn,
    duration_ms: Date.now() - started,
  });
  return left.length > 0 ? { jobs: stopped, turn, running: left.length } : { jobs: stopped, turn };
}
