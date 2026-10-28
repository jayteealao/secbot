/**
 * Board operations: every change to a job row happens inside a commit (a tool's `api.commit` or a
 * task's `runtime.commit`), so the board and the work it describes never disagree after a crash.
 * The board holds every job (C1); the lead's prompt shows only the live ones and a count of the rest.
 */
import type { Tx } from "@earendil-works/pi-durable";
import {
  JobBoardDoc,
  type JobPriority,
  type JobResult,
  type JobRow,
  type JobStatus,
  type Receipt,
  type ResultKind,
  TierSettingsDoc,
} from "./docs.ts";
import type { JobEffort, Tier } from "./release-defaults.ts";
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

/** A job's cost: its conversation's ledger total, which only grows. */
export async function recordCost(tx: Tx, n: number, total: number): Promise<void> {
  const row = await mustRow(tx, n);
  row.cost = Math.max(row.cost, total);
}

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
