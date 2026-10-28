/**
 * Board operations: every change to a job row happens inside a commit (a tool's `api.commit` or a
 * task's `runtime.commit`), so the board and the work it describes never disagree after a crash.
 * The board holds every job (C1); the lead's prompt shows only the live ones and a count of the rest.
 */
import { type ConversationId, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import {
  emptyJobExtras,
  JobBoardDoc,
  type JobPause,
  type JobPriority,
  type JobQuestion,
  type JobResult,
  type JobRow,
  type JobStatus,
  type Receipt,
  type ResultKind,
  TierSettingsDoc,
} from "./docs.ts";
import { conversationTotal } from "./month-ledger.ts";
import { ESCALATION_LIMITS, type JobEffort, type Tier } from "./release-defaults.ts";
import { capOf } from "./templates.ts";

/** Statuses of a job that no longer runs. */
export const ENDED: ReadonlySet<JobStatus> = new Set(["done", "failed", "stopped"]);

export type BoardState = {
  readonly nextNumber: number;
  readonly jobs: Readonly<Record<string, JobRow>>;
  readonly byConversation: Readonly<Record<string, number>>;
};

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
  return board.jobs[String(number)] as JobRow;
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

/** A paused job runs again: its pause is cleared. True when it was paused. */
export async function resumeRow(tx: Tx, n: number): Promise<boolean> {
  const row = await mustRow(tx, n);
  if (row.status !== "paused") return false;
  row.status = "running";
  row.pause = null;
  return true;
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
  }
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

/** The jobs still live (not done, failed, or stopped), by number. */
export function liveRows(board: BoardState): JobRow[] {
  return Object.values(board.jobs)
    .filter((row) => !ENDED.has(row.status))
    .sort((a, b) => a.number - b.number);
}

/** How many jobs ended. */
export function restCount(board: BoardState): number {
  return Object.values(board.jobs).filter((row) => ENDED.has(row.status)).length;
}
