/**
 * A cell's job moves for the person and the owner: answering a job's question, resuming,
 * reordering, stopping, the board view, and the person's side of shared jobs. CellHarness hands
 * its routes here; the lead's own moves are its tools (lead-tools.ts).
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { type BoardView, boardView, budgetJobs } from "./board-view.ts";
import { effectiveCapacity } from "./capacity-watch.ts";
import { logEvent } from "./cell-parts.ts";
import { BudgetWaitsDoc, CapacityDoc, JobBoardDoc, type JobStop, TemplatesDoc } from "./docs.ts";
import { readGuardMode } from "./guard-settings.ts";
import {
  answerQuestion,
  markUrgent,
  moveBefore,
  openQuestion,
  type ResumeRefusal,
  setDeadline,
  waitingCounts,
} from "./job-board.ts";
import { withLiveCosts } from "./job-gate.ts";
import type { JobHolds } from "./job-holds.ts";
import type { JobTask } from "./job-task.ts";
import type { BudgetState } from "./limits.ts";
import { openReceipts, type ReceiptTask } from "./receipts.ts";
import { logResumed, resumeInCommit } from "./resume-job.ts";
import { personOffers } from "./session-stream.ts";
import {
  kickShared,
  type SharedParts,
  type SyncOutcome,
  sharedOpId,
  syncShared,
} from "./shared-relay.ts";
import { type StopAnswer, stopJobs } from "./stop.ts";
import { templatesOf } from "./templates.ts";

export interface CellJobsParts {
  readonly person: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly now: () => number;
  readonly timeZone: string;
  readonly tasks: { readonly job: JobTask; readonly receipt: ReceiptTask } | undefined;
  readonly holds: JobHolds;
  readonly shared: SharedParts | undefined;
  /** Both budgets against their limits (limits.ts). */
  budgetState(context?: Context): Promise<BudgetState>;
}

export class CellJobs {
  readonly person: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly now: () => number;
  readonly timeZone: string;
  readonly tasks: CellJobsParts["tasks"];
  readonly holds: JobHolds;
  readonly shared: SharedParts | undefined;
  private readonly parts: CellJobsParts;

  constructor(parts: CellJobsParts) {
    this.parts = parts;
    this.person = parts.person;
    this.harness = parts.harness;
    this.root = parts.root;
    this.now = parts.now;
    this.timeZone = parts.timeZone;
    this.tasks = parts.tasks;
    this.holds = parts.holds;
    this.shared = parts.shared;
  }

  private budgetState(context: Context): Promise<BudgetState> {
    return this.parts.budgetState(context);
  }

  /** One shared-job exchange with the household now (the routine runs one every 2 minutes). */
  syncShared(context: Context = BACKGROUND_CONTEXT): Promise<SyncOutcome> {
    return this.shared === undefined
      ? Promise.resolve({ outcome: "skipped" })
      : syncShared(this.shared, context);
  }

  /** Starts an exchange in the background, after a shared action; never awaited by a tool. */
  kickShared(context: Context = BACKGROUND_CONTEXT): void {
    if (this.shared !== undefined) kickShared(this.shared, context);
  }

  /**
   * The person answers a job's question that was put to them. A job waiting on it goes on; the
   * answer to an escalation question (a job that used its raise and its restart) goes to the lead,
   * and the job stays failed.
   */
  async answerJob(
    n: number,
    answer: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<
    | { readonly ok: true; readonly job: number; readonly title: string }
    | { readonly ok: false; readonly reason: "no-job" | "no-question"; readonly message: string }
  > {
    const at = this.now();
    const done = await this.harness.commit(async (tx) => {
      const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
      if (row === undefined) return { ok: false as const, reason: "no-job" as const };
      const open = openQuestion(row);
      if (open === null || !open.toPerson) {
        return { ok: false as const, reason: "no-question" as const };
      }
      const question = await answerQuestion(tx, n, answer, "person", at);
      return {
        ok: true as const,
        title: row.title,
        from: question?.from ?? "job",
        number: question?.number ?? 0,
      };
    }, context);
    if (!done.ok) {
      return {
        ok: false,
        reason: done.reason,
        message: done.reason === "no-job" ? `no job #${n}` : `job ${n} has no question waiting`,
      };
    }
    if (done.from === "escalation") {
      await this.root.submit(
        {
          type: "input",
          content: `[job ${n}: the person answered: ${answer}]`,
          whenBusy: "followUp",
          requestId: `answer:${n}:${done.number}`,
        },
        context,
      );
    } else {
      this.holds.wake(n);
    }
    logEvent("job.answered", {
      cell: this.person,
      job: n,
      by: "person",
      answer_chars: answer.length,
    });
    return { ok: true, job: n, title: done.title };
  }

  /**
   * The person resumes stopped or blocked job `n` from its kept brief, board entry, and
   * transcript (`by` "lead" when the lead does it on the person's ask). It does not use the job's
   * restart. Refused for a missing number, a paused job, any other status, and while a stop runs.
   */
  async resumeJob(
    n: number,
    by: "person" | "lead" = "person",
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<
    | { readonly ok: true; readonly job: number; readonly title: string }
    | { readonly ok: false; readonly reason: ResumeRefusal }
  > {
    const task = this.tasks?.job;
    if (task === undefined) throw new Error("the job task is not registered");
    const done = await this.harness.commit(
      (tx) => resumeInCommit(tx, { task, person: this.person, at: this.now(), by }, n),
      context,
    );
    if (!done.ok) return { ok: false, reason: done.reason };
    if (done.shared) this.kickShared(context);
    logResumed(this.person, done, by);
    return { ok: true, job: done.job, title: done.title };
  }

  /**
   * Sets or clears this cell's measured number and its date (the owner's setting; the release
   * default applies while it is unset); the last alert is kept, so a change sends no new alert.
   */
  async setCapacity(
    measured: number | null,
    at: number | null,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ measured: number | null; at: number | null }> {
    await this.harness.commit(async (tx) => {
      Object.assign(await tx.doc(CapacityDoc), { measured, at });
    }, context);
    return { measured, at };
  }

  /**
   * The person's board view: live jobs in queue order, then those that ended in the last 24 hours,
   * each with its reason line; the guard mode, the results waiting for the lead, and the capacity
   * warning when more jobs run than the cell was measured at.
   */
  async jobsView(context: Context = BACKGROUND_CONTEXT): Promise<BoardView> {
    // The view shows the last mirrored state; an exchange in the background catches shared jobs
    // up with the household for the next read, so a slow household never holds the view.
    this.kickShared(context);
    const board = await withLiveCosts(this.harness, await this.board(context), context);
    const waits = (await this.harness.snapshot(BudgetWaitsDoc, context))?.tasks ?? {};
    const { mode } = await readGuardMode(this.harness, context);
    const capacity = effectiveCapacity(
      (await this.harness.snapshot(CapacityDoc, context)) ?? undefined,
    ) ?? { measured: null, at: null };
    const custom = (await this.harness.snapshot(TemplatesDoc, context))?.custom ?? {};
    const counts = waitingCounts(board, await openReceipts(this.harness, context));
    const { spend } = await this.budgetState(context);
    return boardView({
      person: this.person,
      board,
      budgetJobs: budgetJobs(board, waits),
      mode,
      capacity,
      templates: templatesOf(custom),
      waiting: counts.failure + counts.question + counts.risky + counts.routine,
      resetsAt: spend.resetsAt,
      now: this.now(),
      timeZone: this.timeZone,
    });
  }

  /**
   * The stop command: every unfinished job and the lead's current turn stop, with their state
   * kept; routines and reminders keep their schedule. `by` is the person, or the owner's stop of
   * every cell.
   */
  stop(by: JobStop["by"] = "person", context: Context = BACKGROUND_CONTEXT): Promise<StopAnswer> {
    const shared = this.shared;
    return stopJobs(
      {
        harness: this.harness,
        root: this.root,
        person: this.person,
        now: this.now,
        ...(shared === undefined
          ? {}
          : {
              shared: {
                opId: () => sharedOpId(this.person, this.now()),
                sync: (quiet: Context) => syncShared(shared, quiet),
              },
            }),
      },
      by,
      context,
    );
  }

  /**
   * The person changes job `n`'s place in the queue: urgent (first), a deadline or none (placed
   * by priority), or right before job `before`. Refused for a missing number or an ended job.
   */
  async reorderJob(
    n: number,
    change:
      | { readonly urgent: true }
      | { readonly deadline: string | null }
      | { readonly before: number },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<
    | {
        readonly ok: true;
        readonly job: number;
        readonly title: string;
        readonly priority: string;
        readonly deadline: string | null;
        readonly place: number;
        readonly of: number;
        readonly before?: number;
      }
    | { readonly ok: false; readonly reason: "no-job" | "ended"; readonly job: number }
  > {
    const answer = await this.harness.commit(async (tx) => {
      const done =
        "urgent" in change
          ? await markUrgent(tx, n)
          : "before" in change
            ? await moveBefore(tx, n, change.before)
            : await setDeadline(tx, n, change.deadline);
      return "refused" in done
        ? ({ ok: false, reason: done.refused, job: done.job } as const)
        : ({
            ok: true,
            job: done.row.number,
            title: done.row.title,
            priority: done.row.priority,
            deadline: done.row.deadline,
            place: done.place,
            of: done.of,
            ...("before" in change ? { before: change.before } : {}),
          } as const);
    }, context);
    if (answer.ok) {
      logEvent("job.reordered", {
        cell: this.person,
        job: n,
        change: "urgent" in change ? "urgent" : "before" in change ? "move" : "deadline",
        place: answer.place,
        of: answer.of,
      });
    }
    return answer;
  }

  /**
   * The person joins or declines a shared job the other person proposed: an offer on this board
   * that the lead gave or the household sent. One commit queues the answer for the household, then
   * an exchange in the background delivers it; a household that does not answer gets it at the next.
   */
  async answerShared(
    n: number,
    join: boolean,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<
    | {
        readonly ok: true;
        readonly job: number;
        readonly title: string;
        readonly from: string;
        readonly payer: "half" | "you" | "them";
      }
    | { readonly ok: false; readonly message: string }
  > {
    const at = this.now();
    const person = this.person;
    const done = await this.harness.commit(async (tx) => {
      const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
      const link = row?.shared;
      if (
        row === undefined ||
        link === null ||
        link === undefined ||
        link.role !== "other" ||
        link.household === null ||
        (link.consent !== "offered" && link.consent !== "shown")
      ) {
        return null;
      }
      link.consent = join ? "joined" : "declined";
      link.outbox.push({
        kind: "answer",
        opId: sharedOpId(person, at),
        person,
        household: link.household,
        local: n,
        join,
      });
      return { title: row.title, from: link.with, payer: link.payer, household: link.household };
    }, context);
    if (done === null) return { ok: false, message: `no shared job #${n} waits for you` };
    logEvent("shared.answered", {
      cell: person,
      job: n,
      household: done.household,
      answer: join ? "join" : "decline",
    });
    this.kickShared(context);
    return { ok: true, job: n, title: done.title, from: done.from, payer: done.payer };
  }

  /** The shared-job offers the lead gave the person that wait for their answer, by number. */
  async openOffers(context: Context = BACKGROUND_CONTEXT) {
    return personOffers((await this.board(context)).jobs).sort((a, b) => a.job - b.job);
  }

  /** The questions put to the person that wait for their answer, oldest first. */
  async openQuestions(context: Context = BACKGROUND_CONTEXT) {
    const board = await this.board(context);
    return Object.values(board.jobs)
      .flatMap((row) => {
        const open = openQuestion(row);
        return open === null || !open.toPerson
          ? []
          : [{ job: row.number, title: row.title, question: open.text, askedAt: open.askedAt }];
      })
      .sort((a, b) => a.askedAt - b.askedAt || a.job - b.job);
  }

  /** The person's job board, as committed. */
  async board(context: Context = BACKGROUND_CONTEXT) {
    return (
      (await this.harness.snapshot(JobBoardDoc, context)) ?? {
        nextNumber: 1,
        jobs: {},
        byConversation: {},
        queue: [],
      }
    );
  }
}
