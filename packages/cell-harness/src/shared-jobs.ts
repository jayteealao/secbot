/**
 * The household's shared jobs: a job that belongs to both people runs on the household's own job
 * board. This store keeps, per household job, who asked, whose yes it needs, where the consent
 * stands, each person's own number for it, and what each person has been charged. Person cells
 * pull everything through one exchange (`exchange`): their operations go in, each applied once by
 * its operation id, and their shared jobs come out. The household never calls a person cell.
 */
import { defineDoc, ROOT_CONVERSATION_ID, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { ENDED, JobBoardDoc } from "./docs.ts";
import type { SharedCharge, SharedOp } from "./household-contract.ts";
import { createJobRow, endRow, type ResumeRefusal, restartRow, storeResult } from "./job-board.ts";
import { type JobTask, resumeJobTask } from "./job-task.ts";
import { SHARED_DECLINED } from "./release-defaults.ts";

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
