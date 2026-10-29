/**
 * Resuming a stopped or blocked job, for the person's route and the lead's tool alike. A job of
 * this cell gets a new job task from its kept transcript; a shared job runs in the household, so
 * its resume is queued there as an operation, never run here on this person's model and budget.
 */
import type { Tx } from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, StopDoc } from "./docs.ts";
import type { ResumeRefusal } from "./job-board.ts";
import { type JobTask, resumeJobTask } from "./job-task.ts";
import { sharedOpId } from "./shared-relay.ts";

export type Resumed =
  | {
      readonly ok: true;
      readonly job: number;
      readonly title: string;
      readonly resumes: number;
      /** The resume went to the household as an operation: an exchange delivers it. */
      readonly shared: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ResumeRefusal;
      /** The row's status, for the refusal text ("" when there is no row). */
      readonly status: string;
      /** A shared job the household has not taken yet: the other person it waits on. */
      readonly waitingOn: string | null;
    };

/** Resumes job `n` in the caller's commit (see the file comment). */
export async function resumeInCommit(
  tx: Tx,
  deps: {
    readonly task: JobTask;
    readonly person: string;
    readonly at: number;
    readonly by: "person" | "lead";
  },
  n: number,
): Promise<Resumed> {
  const board = await tx.doc(JobBoardDoc);
  const row = Object.hasOwn(board.jobs, String(n)) ? board.jobs[String(n)] : undefined;
  const status = row?.status ?? "";
  const link = row?.shared ?? null;
  if (row !== undefined && link !== null) {
    if ((await tx.doc(StopDoc)).active !== null) {
      return { ok: false, reason: "locked", status, waitingOn: null };
    }
    if (link.household === null) {
      return { ok: false, reason: "not-stopped", status, waitingOn: link.with };
    }
    if (row.status !== "stopped" && row.status !== "blocked") {
      return { ok: false, reason: "not-stopped", status, waitingOn: null };
    }
    link.outbox.push({
      kind: "resume",
      opId: sharedOpId(deps.person, deps.at),
      person: deps.person,
      household: link.household,
    });
    return { ok: true, job: row.number, title: row.title, resumes: 0, shared: true };
  }
  const resumed = await resumeJobTask(tx, deps.task, n, deps.at, deps.by);
  if ("refused" in resumed) {
    return { ok: false, reason: resumed.refused, status, waitingOn: null };
  }
  return {
    ok: true,
    job: resumed.ok.number,
    title: resumed.ok.title,
    resumes: resumed.ok.resumes,
    shared: false,
  };
}

/** The log line of a resume that went through. */
export function logResumed(
  person: string,
  resumed: { readonly job: number; readonly resumes: number },
  by: "person" | "lead",
): void {
  logEvent("job.resumed", { cell: person, job: resumed.job, by, resumes: resumed.resumes });
}
