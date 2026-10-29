/**
 * The household's shared jobs: a job that belongs to both people runs on the household's own job
 * board. This store keeps, per household job, who asked, whose yes it needs, where the consent
 * stands, each person's own number for it, and what each person has been charged. Person cells
 * pull everything through one exchange (`exchange`): their operations go in, each applied once by
 * its operation id, and their shared jobs come out. The household never calls a person cell.
 */
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type Harness,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { SetTimer } from "./approvals.ts";
import type { BudgetWaiter } from "./budget-gate.ts";
import { ENDED, JobBoardDoc, type JobRow } from "./docs.ts";
import type {
  SharedCharge,
  SharedOp,
  SharedSyncAnswer,
  SharedSyncRequest,
  SharedSyncRow,
} from "./household-contract.ts";
import {
  createJobRow,
  endRow,
  jobCost,
  type ResumeRefusal,
  restartRow,
  storeResult,
} from "./job-board.ts";
import { type JobTask, resumeJobTask } from "./job-task.ts";
import { PAYER_POLL_MS, SHARED_DECLINED } from "./release-defaults.ts";
import { payerOf, splitCharge } from "./shared-split.ts";

/** One delivered operation's answer, kept so a repeat gets the same answer. */
export type SharedAck = { opId: string; household?: number; error?: string };

/** One shared job in the household. */
export type SharedEntry = {
  requester: string;
  other: string;
  consent: "asked" | "joined" | "declined";
  estimateUsd: number;
  /** Each person's own number for the job (the other person's once they answered). */
  local: Record<string, number>;
  /** The job's cost already split into charges, in USD. */
  settledUsd: number;
  chargeSeq: number;
  charges: SharedCharge[];
};

/** `secbot.shared-jobs`: every shared job by its household number, and every applied operation. */
export const SharedJobsDoc = defineDoc<{
  jobs: Record<string, SharedEntry>;
  ops: Record<string, SharedAck>;
}>({
  kind: "secbot.shared-jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {}, ops: {} }),
});

/** The owner a shared job's row names on the household board. */
export const SHARED_OWNER = "shared";

export interface ApplyDeps {
  readonly task: JobTask;
  readonly now: number;
}

/** What applying operations asks the caller to do after the commit. */
export interface Applied {
  readonly acks: SharedAck[];
  /** Household jobs a person's stop halts (the caller stops them after the commit). */
  readonly stops: { readonly person: string; readonly jobs: number[] }[];
  /** Tasks a restart replaced or ended (the caller aborts them after the commit). */
  readonly aborts: TaskId[];
  /** Household jobs a join started. */
  readonly started: number[];
}

const RESUME_REFUSALS: Record<ResumeRefusal, (n: number, status: string) => string> = {
  "no-job": (n) => `no shared job ${n}`,
  locked: () => "Everything is being stopped; start it again once the stop is done.",
  paused: (n) => `shared job ${n} is paused, not stopped`,
  "not-stopped": (n, status) => `shared job ${n} is ${status || "not stopped"}`,
};

/** The household jobs a person is part of that a stop halts: joined, and not finished. */
export async function jobsOfPerson(tx: Tx, person: string): Promise<number[]> {
  const shared = await tx.doc(SharedJobsDoc);
  const board = await tx.doc(JobBoardDoc);
  return Object.entries(shared.jobs)
    .filter(([n, entry]) => {
      const row = board.jobs[n];
      return (
        entry.consent === "joined" &&
        (entry.requester === person || entry.other === person) &&
        row !== undefined &&
        !ENDED.has(row.status)
      );
    })
    .map(([n]) => Number(n));
}

type Out = { stops: Applied["stops"]; aborts: TaskId[]; started: number[] };

async function applyOne(tx: Tx, op: SharedOp, deps: ApplyDeps, out: Out): Promise<SharedAck> {
  const shared = await tx.doc(SharedJobsDoc);
  if (op.kind === "propose") {
    if (op.other === op.person) return { opId: op.opId, error: "a shared job needs two people" };
    const row = await createJobRow(tx, {
      title: op.title,
      brief: op.brief,
      priority: op.priority,
      deadline: op.deadline,
      template: "household",
      tier: op.tier,
      effort: { requested: op.effort, applied: op.effort },
      owner: SHARED_OWNER,
      turn: null,
      createdAt: deps.now,
    });
    shared.jobs[String(row.number)] = {
      requester: op.person,
      other: op.other,
      consent: "asked",
      estimateUsd: op.estimateUsd,
      local: { [op.person]: op.local },
      settledUsd: 0,
      chargeSeq: 0,
      charges: [],
    };
    return { opId: op.opId, household: row.number };
  }
  if (op.kind === "stop") {
    out.stops.push({ person: op.person, jobs: await jobsOfPerson(tx, op.person) });
    return { opId: op.opId };
  }
  const n = op.household;
  const entry = shared.jobs[String(n)];
  if (entry === undefined || (entry.requester !== op.person && entry.other !== op.person)) {
    return { opId: op.opId, error: `no shared job ${n} for ${op.person}` };
  }
  if (op.kind === "answer") {
    if (op.person !== entry.other) {
      return { opId: op.opId, error: `only ${entry.other} answers shared job ${n}` };
    }
    if (entry.consent !== "asked") {
      return { opId: op.opId, error: `shared job ${n} was answered already` };
    }
    entry.local[op.person] = op.local;
    if (!op.join) {
      entry.consent = "declined";
      await storeResult(tx, n, "failure", SHARED_DECLINED(entry.other), deps.now);
      await endRow(tx, n, "failed", deps.now);
      return { opId: op.opId, household: n };
    }
    entry.consent = "joined";
    const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
    if (row !== undefined) {
      row.taskId = await tx.createTask(
        deps.task,
        { number: n, attempt: 0 },
        {
          ownership: { kind: "conversation" },
          conversationId: ROOT_CONVERSATION_ID,
          background: true,
        },
      );
      out.started.push(n);
    }
    return { opId: op.opId, household: n };
  }
  if (entry.consent !== "joined") {
    return { opId: op.opId, error: `shared job ${n} has not started` };
  }
  if (op.kind === "restart") {
    if (op.person !== entry.requester) {
      return { opId: op.opId, error: `only ${entry.requester}'s lead restarts this shared job` };
    }
    const answer = await restartRow(tx, deps.task, n, op.note, deps.now);
    if ("missing" in answer) return { opId: op.opId, error: `no shared job ${n}` };
    if ("error" in answer) return { opId: op.opId, error: answer.error };
    if ("exhausted" in answer) {
      if (answer.exhausted.taskId !== null) out.aborts.push(answer.exhausted.taskId);
      return { opId: op.opId, error: `shared job ${n} has used its restart and has stopped` };
    }
    if (answer.oldTaskId !== null) out.aborts.push(answer.oldTaskId);
    return { opId: op.opId, household: n };
  }
  const resumed = await resumeJobTask(tx, deps.task, n, deps.now, "person");
  if ("refused" in resumed) {
    const status = (await tx.doc(JobBoardDoc)).jobs[String(n)]?.status ?? "";
    return { opId: op.opId, error: RESUME_REFUSALS[resumed.refused](n, status) };
  }
  return { opId: op.opId, household: n };
}

/**
 * Applies one person's operations in the caller's commit, each once by its operation id (a repeat
 * gets its stored answer). An operation for a job the person is not part of, an answer from the
 * requesting person, and an operation naming another person get an error answer and change
 * nothing.
 */
export async function applyOps(
  tx: Tx,
  person: string,
  ops: readonly SharedOp[],
  deps: ApplyDeps,
): Promise<Applied> {
  const shared = await tx.doc(SharedJobsDoc);
  const out: Out = { stops: [], aborts: [], started: [] };
  const acks: SharedAck[] = [];
  for (const op of ops) {
    const done = shared.ops[op.opId];
    if (done !== undefined) {
      acks.push({ ...done });
      continue;
    }
    const ack =
      op.person !== person
        ? { opId: op.opId, error: `an operation of ${op.person} came from ${person}` }
        : await applyOne(tx, op, deps, out);
    shared.ops[op.opId] = ack;
    acks.push({ ...ack });
  }
  return { acks, ...out };
}

/** One person's newest month as the household budget board has it. */
export type PayerReport = {
  readonly cell: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
};

/** Reads every person's newest report from the household budget board. */
export type Budgets = () => Promise<readonly PayerReport[]>;

/** Whether a person's budget is used up: their newest report is at or over their limit. */
export function overOf(reports: readonly PayerReport[]): (person: string) => boolean {
  const used = new Set(reports.filter((r) => r.spentUsd >= r.limitUsd).map((r) => r.cell));
  return (person) => used.has(person);
}

/**
 * Splits every joined job's cost since its last settlement into one charge per paying person
 * (half each; all to the other person when one budget is used up), in the caller's commit. Charge
 * ids name the job, the settlement, and the person, so a person books each one once.
 */
export async function settle(
  tx: Tx,
  over: (person: string) => boolean,
  now: number,
): Promise<SharedCharge[]> {
  const shared = await tx.doc(SharedJobsDoc);
  const board = await tx.doc(JobBoardDoc);
  const made: SharedCharge[] = [];
  for (const [n, entry] of Object.entries(shared.jobs)) {
    const row = board.jobs[n];
    if (entry.consent !== "joined" || row === undefined) continue;
    const cost = Math.max(row.cost, await jobCost(tx, row));
    const due = cost - entry.settledUsd;
    if (due < 0.000001) continue;
    entry.chargeSeq += 1;
    const { shares, split } = splitCharge(due, entry.requester, entry.other, over);
    for (const person of [entry.requester, entry.other]) {
      const usd = shares[person] ?? 0;
      if (usd <= 0) continue;
      const charge = {
        id: `shared:${n}:${entry.chargeSeq}:${person}`,
        person,
        usd,
        at: now,
        split,
      };
      entry.charges.push(charge);
      made.push(charge);
    }
    entry.settledUsd = cost;
  }
  return made;
}

/** What a person's lead may relay of a household result: a risky one only after its review. */
function relayable(row: JobRow): SharedSyncRow["result"] {
  const result = row.result;
  if (result === null) return null;
  if (result.kind !== "risky") return { kind: result.kind, text: result.text, at: result.at };
  if (row.review?.status === "passed") return { kind: "risky", text: result.text, at: result.at };
  if (row.review?.status === "rejected") {
    return { kind: "failure", text: `review rejected: ${row.review.reason}`, at: row.review.at };
  }
  return null;
}

/** Every shared job a person proposed or was asked into, from their side. */
export async function rowsFor(
  tx: Tx,
  person: string,
  over: (person: string) => boolean,
  waiting: ReadonlySet<number> = new Set(),
): Promise<SharedSyncRow[]> {
  const shared = await tx.doc(SharedJobsDoc);
  const board = await tx.doc(JobBoardDoc);
  const rows: SharedSyncRow[] = [];
  for (const [n, entry] of Object.entries(shared.jobs)) {
    if (entry.requester !== person && entry.other !== person) continue;
    const row = board.jobs[n];
    if (row === undefined) continue;
    const role = entry.requester === person ? "requester" : "other";
    rows.push({
      household: row.number,
      requester: entry.requester,
      other: entry.other,
      title: row.title,
      consent: entry.consent,
      status: row.status,
      pause: row.pause === null ? null : { ...row.pause },
      block: row.block === null ? null : { cause: row.block.cause, at: row.block.at },
      waitingBudget: waiting.has(row.number),
      tier: row.tier,
      effort: { ...row.effort },
      attempts: { ...row.attempts },
      cost: row.cost,
      cap: row.cap,
      estimateUsd: entry.estimateUsd,
      payer: payerOf(role, over(entry.requester), over(entry.other)),
      local: entry.local[person] ?? null,
      result: relayable(row),
      charges: entry.charges.filter((charge) => charge.person === person).map((c) => ({ ...c })),
    });
  }
  return rows;
}

export interface ExchangeDeps {
  readonly task: JobTask;
  readonly budgets: Budgets;
  readonly now: () => number;
  /** Household jobs held until a payer has budget again (the payer gate). */
  readonly waiting?: () => ReadonlySet<number>;
}

/**
 * One exchange with a person cell, in one commit: the person's operations, then settlement of
 * every joined job, then that person's rows. The stops and aborts it asks for are the caller's to
 * run after the commit.
 */
export async function exchange(
  harness: Harness,
  request: SharedSyncRequest,
  deps: ExchangeDeps,
  context: Context,
): Promise<{ readonly answer: SharedSyncAnswer; readonly applied: Applied }> {
  const over = overOf(await deps.budgets());
  const now = deps.now();
  return harness.commit(async (tx) => {
    const applied = await applyOps(tx, request.person, request.ops, { task: deps.task, now });
    await settle(tx, over, now);
    const rows = await rowsFor(tx, request.person, over, deps.waiting?.());
    return { answer: { acks: applied.acks, rows }, applied };
  }, context);
}

export interface PayerGateOptions {
  readonly harness: () => Harness;
  readonly budgets: Budgets;
  readonly setTimer: SetTimer;
  /** A job started or stopped waiting on its payers. */
  readonly onWaitChange?: () => void;
}

/** The household's budget wait, with the jobs that wait now. */
export interface PayerGate extends BudgetWaiter {
  waiting(): ReadonlySet<number>;
}

const JOB_OF_WAIT = /^job ([0-9]+)(?: |$)/;

/**
 * The household's budget wait: before each model request, a shared job waits while every person
 * who pays for it (the requesting person, and the other once they joined) is at or over their
 * limit by their newest board report. It checks again every minute; an abort ends the wait.
 */
export function createPayerGate(options: PayerGateOptions): PayerGate {
  const waiting = new Set<number>();
  const mark = (n: number, on: boolean) => {
    if (waiting.has(n) === on) return;
    if (on) waiting.add(n);
    else waiting.delete(n);
    options.onWaitChange?.();
  };
  const payersOver = async (n: number, context: Context): Promise<boolean> => {
    const entry = (await options.harness().snapshot(SharedJobsDoc, context))?.jobs[String(n)];
    if (entry === undefined) return false;
    const over = overOf(await options.budgets());
    const payers = entry.consent === "joined" ? [entry.requester, entry.other] : [entry.requester];
    return payers.every(over);
  };
  const pause = (context: Context) =>
    new Promise<void>((resolve, reject) => {
      const signal = context.abortSignal;
      if (signal?.aborted === true) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const onAbort = () => {
        cancel();
        reject(signal?.reason ?? new Error("aborted"));
      };
      const cancel = options.setTimer(PAYER_POLL_MS, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  return {
    waiting: () => waiting,
    isOver: async () => false,
    waitUntilUnder: async (request, context) => {
      const n = Number(JOB_OF_WAIT.exec(request.what)?.[1] ?? Number.NaN);
      if (!Number.isInteger(n)) return;
      try {
        while (await payersOver(n, context)) {
          mark(n, true);
          await pause(context);
        }
      } finally {
        mark(n, false);
      }
    },
  };
}
