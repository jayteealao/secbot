/**
 * Board operations: every change to a job row happens inside a commit (a tool's `api.commit` or a
 * task's `runtime.commit`), so the board and the work it describes never disagree after a crash.
 * The board holds every job (C1); the lead's prompt shows only the live ones and a count of the rest.
 */
import {
  type ConversationId,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import {
  compareKeys,
  ENDED,
  emptyJobExtras,
  type JobBlock,
  JobBoardDoc,
  type JobPause,
  type JobPriority,
  type JobQuestion,
  type JobResult,
  type JobRow,
  type JobStatus,
  priorityKey,
  type Receipt,
  type ResultKind,
  type SharedLink,
  StopDoc,
  TierSettingsDoc,
} from "./docs.ts";
import type { JobTask } from "./job-task.ts";
import { conversationTotal } from "./month-ledger.ts";
import {
  ESCALATION_LIMITS,
  type JobEffort,
  type OutsideKind,
  type Tier,
} from "./release-defaults.ts";
import { STOP_RUNNING } from "./stop.ts";
import { capOf } from "./templates.ts";

export { ENDED, priorityKey };

export type BoardState = {
  readonly nextNumber: number;
  readonly jobs: Readonly<Record<string, JobRow>>;
  readonly byConversation: Readonly<Record<string, number>>;
  /** The live jobs in order; a board read before the queue existed has none. */
  readonly queue?: readonly number[];
};

type MutableBoard = {
  nextNumber: number;
  jobs: Record<string, JobRow>;
  byConversation: Record<string, number>;
  queue: number[];
};

/** The index in `queue` where job `n` goes: after every live job of the same or a higher priority. */
function placeIndex(board: BoardState, queue: readonly number[], n: number): number {
  const row = board.jobs[String(n)];
  if (row === undefined) return queue.length;
  const key = priorityKey(row);
  let at = 0;
  queue.forEach((other, index) => {
    const ahead = board.jobs[String(other)];
    if (ahead !== undefined && compareKeys(priorityKey(ahead), key) <= 0) at = index + 1;
  });
  return at;
}

/**
 * The live jobs in the order they run and show: the queue's order, with a live job the queue does
 * not list placed by its priority (older first) and every ended job left out.
 */
export function queueOf(board: BoardState): JobRow[] {
  const live = (n: number) => {
    const row = board.jobs[String(n)];
    return row !== undefined && !ENDED.has(row.status);
  };
  const queue = [...new Set(board.queue ?? [])].filter(live);
  const missing = Object.values(board.jobs)
    .filter((row) => !ENDED.has(row.status) && !queue.includes(row.number))
    .sort((a, b) => a.number - b.number);
  for (const row of missing) queue.splice(placeIndex(board, queue, row.number), 0, row.number);
  return queue.map((n) => board.jobs[String(n)] as JobRow);
}

/** Job `n`'s place in the queue (from 1) and the number of live jobs; null when it is not live. */
export function placeOf(board: BoardState, n: number): { place: number; of: number } | null {
  const order = queueOf(board).map((row) => row.number);
  const index = order.indexOf(n);
  return index < 0 ? null : { place: index + 1, of: order.length };
}

/** Rewrites the queue without ended jobs, then puts job `n` where `where` says. */
function requeue(board: MutableBoard, n: number, where: (queue: number[]) => number): void {
  const queue = queueOf(board)
    .map((row) => row.number)
    .filter((other) => other !== n);
  const at = where(queue);
  // A place that is not in the queue puts the job last rather than before the last job.
  queue.splice(at < 0 ? queue.length : at, 0, n);
  board.queue = queue;
}

/** Places job `n` after every live job of the same or a higher priority. */
export function placeInQueue(board: MutableBoard, n: number): void {
  requeue(board, n, (queue) => placeIndex(board, queue, n));
}

export type ReorderAnswer =
  | { readonly ok: true; readonly row: JobRow; readonly place: number; readonly of: number }
  | { readonly refused: "no-job" | "ended"; readonly job: number };

async function liveRowFor(
  tx: Tx,
  n: number,
): Promise<{ board: MutableBoard; row: JobRow } | { refused: "no-job" | "ended"; job: number }> {
  const board = await tx.doc(JobBoardDoc);
  const row = Object.hasOwn(board.jobs, String(n)) ? board.jobs[String(n)] : undefined;
  if (row === undefined) return { refused: "no-job", job: n };
  if (ENDED.has(row.status)) return { refused: "ended", job: n };
  return { board, row };
}

function answered(board: MutableBoard, row: JobRow): ReorderAnswer {
  const place = placeOf(board, row.number);
  return { ok: true, row, place: place?.place ?? 0, of: place?.of ?? 0 };
}

/** The person marks job `n` urgent: it goes first. */
export async function markUrgent(tx: Tx, n: number): Promise<ReorderAnswer> {
  const found = await liveRowFor(tx, n);
  if ("refused" in found) return found;
  found.row.priority = "urgent";
  requeue(found.board, n, () => 0);
  return answered(found.board, found.row);
}

/**
 * The person sets job `n`'s deadline (an ISO date): it is placed among the deadlines by date. A
 * cleared deadline makes the job routine, placed after the other routine jobs.
 */
export async function setDeadline(tx: Tx, n: number, date: string | null): Promise<ReorderAnswer> {
  const found = await liveRowFor(tx, n);
  if ("refused" in found) return found;
  found.row.priority = date === null ? "routine" : "deadline";
  found.row.deadline = date;
  placeInQueue(found.board, n);
  return answered(found.board, found.row);
}

/** The person moves job `n` right before job `m`; its priority stays. */
export async function moveBefore(tx: Tx, n: number, m: number): Promise<ReorderAnswer> {
  const found = await liveRowFor(tx, n);
  if ("refused" in found) return found;
  const target = await liveRowFor(tx, m);
  if ("refused" in target) return target;
  // Moving a job before itself keeps its place.
  if (n !== m) requeue(found.board, n, (queue) => queue.indexOf(m));
  return answered(found.board, found.row);
}

export interface NewJob {
  readonly title: string;
  readonly brief: string;
  readonly priority: JobPriority;
  readonly deadline: string | null;
  readonly template: string;
  readonly tier: Tier;
  readonly effort: { readonly requested: JobEffort; readonly applied: string };
  readonly owner: string;
  readonly turn: number | null;
  readonly createdAt: number;
}

/** The row of job `n`, or undefined. */
export async function jobRow(tx: Tx, n: number): Promise<JobRow | undefined> {
  const board = await tx.doc(JobBoardDoc);
  return Object.hasOwn(board.jobs, String(n)) ? board.jobs[String(n)] : undefined;
}

async function mustRow(tx: Tx, n: number): Promise<JobRow> {
  const row = await jobRow(tx, n);
  if (row === undefined) throw new Error(`no job ${n} on the board`);
  return row;
}

/** Adds a queued job with the next number; its cap is the cap of its tier. Returns the row. */
export async function createJobRow(tx: Tx, fields: NewJob): Promise<JobRow> {
  const board = await tx.doc(JobBoardDoc);
  const caps = (await tx.doc(TierSettingsDoc)).caps;
  const number = board.nextNumber;
  board.nextNumber = number + 1;
  board.jobs[String(number)] = {
    number,
    title: fields.title,
    brief: fields.brief,
    priority: fields.priority,
    deadline: fields.deadline,
    template: fields.template,
    tier: fields.tier,
    effort: { requested: fields.effort.requested, applied: fields.effort.applied },
    attempts: { raises: 0, restarts: 0 },
    cost: 0,
    cap: capOf(fields.tier, caps),
    status: "queued",
    owner: fields.owner,
    conversationId: null,
    taskId: null,
    turn: fields.turn,
    createdAt: fields.createdAt,
    endedAt: null,
    result: null,
    ...emptyJobExtras(),
  };
  placeInQueue(board, number);
  return board.jobs[String(number)] as JobRow;
}

/**
 * Adds a shared job's row on this person's board: owned by the person, on the household template,
 * with no local task (the job runs in the household). It gets its own ledger conversation, so the
 * person's share of the cost is booked where the month and the limits already count it.
 */
export async function createSharedRow(
  tx: Tx,
  fields: Omit<NewJob, "template" | "turn"> & { readonly shared: SharedLink },
): Promise<JobRow> {
  const row = await createJobRow(tx, { ...fields, template: "household", turn: null });
  row.shared = fields.shared;
  const ledger = await tx.createConversation({ ownership: { kind: "ownerless" } });
  row.conversationId = ledger.id;
  (await tx.doc(JobBoardDoc)).byConversation[String(ledger.id)] = row.number;
  await tx.doc(UsageDoc, ledger.id);
  return row;
}

/** Moves a job's tier and effort; the cap follows the tier, the applied effort is stored as given. */
export async function setTierEffort(
  tx: Tx,
  n: number,
  change: { readonly tier?: Tier; readonly requested?: JobEffort; readonly applied: string },
): Promise<JobRow> {
  const row = await mustRow(tx, n);
  if (change.tier !== undefined) row.tier = change.tier;
  if (change.requested !== undefined) row.effort.requested = change.requested;
  row.effort.applied = change.applied;
  row.cap = capOf(row.tier, (await tx.doc(TierSettingsDoc)).caps);
  return row;
}

/** A job's cost: the sum of its conversations' ledger totals (`jobCost`), which only grows. */
export async function recordCost(tx: Tx, n: number, total: number): Promise<void> {
  const row = await mustRow(tx, n);
  row.cost = Math.max(row.cost, total);
}

/**
 * Every conversation a job used: the current run's, each earlier run's, and its review's. A job's
 * cost and its cap count them all, so a restart does not start the job's spend again (D-051).
 */
export function jobConversations(
  row: Pick<JobRow, "conversationId" | "runs" | "review">,
): ConversationId[] {
  const ids = [
    row.conversationId,
    ...row.runs.map((run) => run.conversationId),
    row.review?.conversationId ?? null,
  ].filter((id): id is ConversationId => id !== null);
  return [...new Set(ids)];
}

/** A job's cost now, in a commit: the ledger totals of every conversation it used. */
export async function jobCost(
  tx: Tx,
  row: Pick<JobRow, "conversationId" | "runs" | "review">,
): Promise<number> {
  let total = 0;
  for (const id of jobConversations(row)) total += conversationTotal(await tx.doc(UsageDoc, id));
  return total;
}

/**
 * Pauses a running job before its next model step; a job that is not running (already paused,
 * waiting, ended) keeps its state and its first pause. True when this call paused it.
 */
export async function pauseRow(
  tx: Tx,
  n: number,
  reason: JobPause["reason"],
  detail: string,
  at: number,
): Promise<boolean> {
  const row = await mustRow(tx, n);
  if (row.status !== "running") return false;
  row.status = "paused";
  row.pause = { reason, at, detail };
  return true;
}

/**
 * A paused job runs again: its pause is cleared, and the loop guard counts failing steps from
 * `at` (wall clock, as message timestamps). True when it was paused.
 */
export async function resumeRow(tx: Tx, n: number, at: number): Promise<boolean> {
  const row = await mustRow(tx, n);
  if (row.status !== "paused") return false;
  row.status = "running";
  row.pause = null;
  row.resumedAt = at;
  return true;
}

export type ResumeRefusal = "no-job" | "paused" | "not-stopped" | "locked";

/**
 * The person resumes a stopped or blocked job (from the command line, or by asking the lead): the
 * run ends in `runs` with its conversation, so the next run continues from its transcript; the row
 * waits `queued` for its new task, in its place in the queue. Cost, cap, attempts, and the
 * outside-content mark stay: a resume is not one of the lead's escalations. Refused while a stop
 * runs, for a paused job (the lead moves it on), and for any other status.
 */
export async function resumeStoppedRow(
  tx: Tx,
  n: number,
  at: number,
  by: "person" | "lead" = "person",
): Promise<{ readonly ok: JobRow } | { readonly refused: ResumeRefusal }> {
  const board = await tx.doc(JobBoardDoc);
  const row = Object.hasOwn(board.jobs, String(n)) ? board.jobs[String(n)] : undefined;
  if (row === undefined) return { refused: "no-job" };
  if ((await tx.doc(StopDoc)).active !== null) return { refused: "locked" };
  if (row.status === "paused") return { refused: "paused" };
  if (row.status !== "stopped" && row.status !== "blocked") return { refused: "not-stopped" };
  const stopped =
    row.status === "blocked"
      ? "blocked"
      : `stopped by the ${row.stop?.by === "owner" ? "owner" : "person"}`;
  row.runs.push({
    conversationId: row.conversationId,
    taskId: row.taskId,
    startedAt: row.runs.at(-1)?.endedAt ?? row.createdAt,
    endedAt: row.endedAt ?? at,
    note: `${stopped}; resumed by the ${by}`,
  });
  row.conversationId = null;
  row.taskId = null;
  row.stop = null;
  row.block = null;
  row.pause = null;
  // The resumed run stores its own result; one the lead never pulled was the stop's or the block's.
  row.result = null;
  row.toolsUsed = [];
  if (row.question?.answer === null) row.question = null;
  row.status = "queued";
  row.endedAt = null;
  // The loop guard counts only the resumed run's failing steps.
  row.resumedAt = at;
  row.resumes++;
  placeInQueue(board, n);
  return { ok: row };
}

export type EscalationMove = "raise" | "restart";

/**
 * Counts one escalation move of the lead against the limits (one raise, one restart, in either
 * order); a move past its limit is refused and changes nothing.
 */
export async function escalate(
  tx: Tx,
  n: number,
  move: EscalationMove,
): Promise<{ readonly ok: true } | { readonly refused: "raise used" | "restart used" }> {
  const row = await mustRow(tx, n);
  if (move === "raise") {
    if (row.attempts.raises >= ESCALATION_LIMITS.raises) return { refused: "raise used" };
    row.attempts.raises++;
  } else {
    if (row.attempts.restarts >= ESCALATION_LIMITS.restarts) return { refused: "restart used" };
    row.attempts.restarts++;
  }
  return { ok: true };
}

/** True when the job has used both its raise and its restart. */
export const escalationsUsed = (row: Pick<JobRow, "attempts">): boolean =>
  row.attempts.raises >= ESCALATION_LIMITS.raises &&
  row.attempts.restarts >= ESCALATION_LIMITS.restarts;

/** The failure text of a job that used its raise and its restart. */
export const EXHAUSTED = "raise and restart used";

/**
 * A job past its escalations ends `failed` ("raise and restart used") and opens the escalation
 * question to the person; the lead asks it in its own words.
 */
export async function exhaust(tx: Tx, n: number, at: number): Promise<JobRow> {
  const row = await mustRow(tx, n);
  row.pause = null;
  if (row.result === null || row.result.pulledAt !== null) {
    row.result = { kind: "failure", text: EXHAUSTED, at, pulledAt: null, wokeAt: null };
  }
  if (row.question === null || row.question.answer !== null || row.question.from !== "escalation") {
    row.question = {
      number: (row.question?.number ?? 0) + 1,
      from: "escalation",
      text: `job ${n} used its raise and its restart; what should happen next?`,
      askedAt: at,
      toPerson: true,
      personAskedAt: at,
      answer: null,
      answeredAt: null,
      answeredBy: null,
    };
  }
  if (!ENDED.has(row.status)) {
    row.status = "failed";
    row.endedAt = at;
    await dropEnded(tx, n);
  }
  return row;
}

/** The job's question that waits for an answer, or null. */
export const openQuestion = (row: Pick<JobRow, "question">): JobQuestion | null =>
  row.question !== null && row.question.answer === null ? row.question : null;

/**
 * The job asks the lead a question: the job waits (status `waiting`) until it is answered. A job
 * with a question already open keeps it. Returns the open question.
 */
export async function askQuestion(
  tx: Tx,
  n: number,
  text: string,
  at: number,
): Promise<JobQuestion> {
  const row = await mustRow(tx, n);
  const open = openQuestion(row);
  if (open !== null) return { ...open };
  row.question = {
    number: (row.question?.number ?? 0) + 1,
    from: "job",
    text,
    askedAt: at,
    toPerson: false,
    personAskedAt: null,
    answer: null,
    answeredAt: null,
    answeredBy: null,
  };
  if (row.status === "running" || row.status === "queued") row.status = "waiting";
  return { ...row.question };
}

/**
 * Answers the job's open question; the first answer wins. A job waiting on its own question runs
 * again in the same commit. Returns a copy of the answered question; null when none waits.
 */
export async function answerQuestion(
  tx: Tx,
  n: number,
  answer: string,
  by: "lead" | "person",
  at: number,
): Promise<JobQuestion | null> {
  const row = await mustRow(tx, n);
  const open = openQuestion(row);
  if (open === null) return null;
  open.answer = answer;
  open.answeredAt = at;
  open.answeredBy = by;
  if (open.from === "job" && row.status === "waiting") row.status = "running";
  return { ...open };
}

/**
 * Adds a risky mark: code's reasons (tools used, the template) or the lead's reason. A mark is
 * never removed; the lead's first reason is kept.
 */
export async function markRisky(
  tx: Tx,
  n: number,
  mark: { readonly code: readonly string[] } | { readonly lead: string },
): Promise<JobRow> {
  const row = await mustRow(tx, n);
  if ("code" in mark) {
    for (const reason of mark.code) {
      if (!row.risky.code.includes(reason)) row.risky.code.push(reason);
    }
  } else {
    row.risky.lead ??= mark.lead;
  }
  return row;
}

/** True when code or the lead marked the job's result risky. */
export const isRisky = (row: Pick<JobRow, "risky">): boolean =>
  row.risky.code.length > 0 || row.risky.lead !== null;

/** Stores a job's result as waiting; a stored result is never replaced. */
export async function storeResult(
  tx: Tx,
  n: number,
  kind: ResultKind,
  text: string,
  at: number,
): Promise<JobResult> {
  const row = await mustRow(tx, n);
  row.result ??= { kind, text, at, pulledAt: null, wokeAt: null };
  return row.result;
}

/** Ends a job with `status` at `at`; an ended job keeps its first end. */
export async function endRow(tx: Tx, n: number, status: JobStatus, at: number): Promise<JobRow> {
  const row = await mustRow(tx, n);
  if (!ENDED.has(row.status)) {
    row.status = status;
    row.endedAt = at;
    await dropEnded(tx, n);
  }
  return row;
}

/** Takes an ended job out of the queue. */
async function dropEnded(tx: Tx, n: number): Promise<void> {
  dropFromQueue(await tx.doc(JobBoardDoc), n);
}

function dropFromQueue(board: { queue: number[] }, n: number): void {
  if (board.queue.includes(n)) board.queue = board.queue.filter((other) => other !== n);
}

/**
 * Marks that the job's current run read outside content through `tool`: each kind and tool is added
 * once, and the first time is kept. A conversation of an earlier run marks nothing. True when this
 * kind is new for the current run.
 */
export async function markOutside(
  tx: Tx,
  n: number,
  conversationId: ConversationId,
  tool: string,
  kind: OutsideKind,
  at: number,
): Promise<boolean> {
  const row = await mustRow(tx, n);
  if (row.conversationId !== conversationId) return false;
  row.outside ??= { at, kinds: [], tools: [] };
  if (!row.outside.tools.includes(tool)) row.outside.tools.push(tool);
  if (row.outside.kinds.includes(kind)) return false;
  row.outside.kinds.push(kind);
  return true;
}

/** The one reason line of a blocked job, in household words. */
export function blockReason(block: JobBlock): string {
  return block.cause === "hit"
    ? `a ${block.kind} tried to give the agent orders; nothing from it was used`
    : "the content check did not answer; stopped to be safe";
}

/**
 * The content check stops the job's current run: the row is `blocked` with why, it ends at the
 * block's time, and its result is a failure holding the reason line. Null when the row is not this
 * run's or has already ended (a second block changes nothing).
 */
export async function blockRow(
  tx: Tx,
  n: number,
  conversationId: ConversationId,
  block: JobBlock,
): Promise<JobRow | null> {
  const row = await mustRow(tx, n);
  if (row.conversationId !== conversationId || ENDED.has(row.status)) return null;
  row.block = { ...block };
  row.status = "blocked";
  row.endedAt = block.at;
  await dropEnded(tx, n);
  row.pause = null;
  await storeResult(tx, n, "failure", blockReason(block), block.at);
  return row;
}

/** The lead pulls a job's result: its first pull time is kept. Null when no result exists yet. */
export async function pullResult(tx: Tx, n: number, at: number): Promise<JobResult | null> {
  const row = await mustRow(tx, n);
  if (row.result === null) return null;
  row.result.pulledAt ??= at;
  return { ...row.result };
}

export type WaitingCounts = Record<ResultKind, number>;

/**
 * What waits for the lead, by kind: unpulled job results, plus finished receipts not read yet (a
 * failed call counts as `failure`, any other as `routine`).
 */
export function waitingCounts(
  board: BoardState,
  receipts: readonly Pick<Receipt, "status" | "isError" | "readAt">[] = [],
): WaitingCounts {
  const counts: WaitingCounts = { failure: 0, question: 0, risky: 0, routine: 0 };
  for (const row of Object.values(board.jobs)) {
    if (row.result !== null && row.result.pulledAt === null) counts[row.result.kind]++;
  }
  for (const receipt of receipts) {
    if (receipt.status === "running" || receipt.readAt !== null) continue;
    counts[receipt.isError || receipt.status === "interrupted" ? "failure" : "routine"]++;
  }
  return counts;
}

/** The jobs still live (not done, failed, stopped, or blocked), in queue order. */
export function liveRows(board: BoardState): JobRow[] {
  return queueOf(board);
}

/** How many jobs ended. */
export function restCount(board: BoardState): number {
  return Object.values(board.jobs).filter((row) => ENDED.has(row.status)).length;
}

/** What restarting a job did: restarted, used up its escalations (and ended), or refused. */
export type RestartAnswer =
  | {
      readonly ok: { readonly number: number; readonly restarts: number; readonly raises: number };
      readonly oldTaskId: TaskId | null;
    }
  | {
      readonly exhausted: {
        readonly number: number;
        readonly taskId: TaskId | null;
        readonly cost: number;
        readonly cap: number;
      };
    }
  | { readonly missing: true }
  | { readonly error: string };

/**
 * Restarts job `n` with a fresh run and a failure note, in the caller's commit: refused while a
 * stop runs, for a job that has not started or is finished, and when its restart is used (a job
 * past both escalations ends failed). The old run moves to `runs` with the note; the job keeps
 * its number, row, and cost, and its new task starts in the background.
 */
export async function restartRow(
  tx: Tx,
  task: JobTask,
  n: number,
  note: string,
  at: number,
): Promise<RestartAnswer> {
  if ((await tx.doc(StopDoc)).active !== null) return { error: STOP_RUNNING };
  const found = await jobRow(tx, n);
  if (found === undefined) return { missing: true };
  if (found.status === "done" || found.status === "stopped" || found.status === "queued") {
    return { error: `job ${n} is ${found.status}; only a started, unfinished job restarts.` };
  }
  const counted = await escalate(tx, n, "restart");
  if ("refused" in counted) {
    if (escalationsUsed(found)) {
      const ended = await exhaust(tx, n, at);
      return {
        exhausted: { number: ended.number, taskId: ended.taskId, cost: ended.cost, cap: ended.cap },
      };
    }
    return { error: `Refused: job ${n} has used its restart; a raise with set_job is left.` };
  }
  const oldTaskId = found.taskId;
  found.cost = Math.max(found.cost, await jobCost(tx, found));
  found.runs.push({
    conversationId: found.conversationId,
    taskId: found.taskId,
    startedAt: found.runs.at(-1)?.endedAt ?? found.createdAt,
    endedAt: at,
    note,
  });
  found.conversationId = null;
  found.pause = null;
  // A blocked job reads its content again in the new run, and is checked again; it keeps its
  // outside-content mark, so its outside actions still need the reviewer.
  found.block = null;
  found.result = null;
  found.toolsUsed = [];
  if (found.question?.answer === null) found.question = null;
  found.status = "queued";
  found.endedAt = null;
  found.resumedAt = null;
  found.taskId = (await tx.createTask(
    task,
    { number: found.number, attempt: found.attempts.restarts },
    { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
  )) as TaskId;
  return {
    ok: { number: found.number, restarts: found.attempts.restarts, raises: found.attempts.raises },
    oldTaskId,
  };
}
