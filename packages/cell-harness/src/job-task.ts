/**
 * The job task: one background task per job, owned by the lead's conversation. Its first commit
 * creates the job's own conversation, owned by the task itself, so the task stays the owner until
 * the job ends and an abort of the task reaches the conversation (pi-durable README "Abort and
 * Subagents": abort runs bottom-up through live owners; a `{ background: true }` task is a
 * boundary the lead's own aborts do not cross). The task submits the brief, waits for the answer,
 * and stores it on the board as a waiting result in the commit that ends the job.
 *
 * Pattern adapted from the hand-off reporter (handoff.ts): request ids made from the job number,
 * and one commit that decides the outcome, so a restart submits once and stores once.
 */

import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineTask,
  type Extension,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type TaskRuntime,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { appendRecord } from "./activity.ts";
import type { BudgetWaiter } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, type JobRow, type ResultKind, RoleModelsDoc, TemplatesDoc } from "./docs.ts";
import {
  ENDED,
  endRow,
  isRisky,
  jobCost,
  markRisky,
  type ResumeRefusal,
  recordCost,
  resumeStoppedRow,
  storeResult,
} from "./job-board.ts";
import { doneRecord, jobRowLabel } from "./jobs.ts";
import { modelRef } from "./model-map.ts";
import { budgetOf } from "./month-ledger.ts";
import { RESULT_WAKE_MS, RISKY_TEMPLATES, RISKY_TOOLS, resumeInput } from "./release-defaults.ts";
import { type ReviewTask, startReview } from "./result-review.ts";
import { templatesOf, tierModelOf } from "./templates.ts";

/** The job task's kind. */
export const JOB_KIND = "secbot.job";

/** How long a job may wait to start before it logs `job.queued_long`. */
export const QUEUED_LONG_MS = 10 * 60_000;

/**
 * A job's number and its attempt: 0 for the first run, then one more per restart. A run the person
 * resumed after a stop or a block names its resume count: it continues the last run's transcript.
 */
export type JobInput = { number: number; attempt: number; resume?: number };

/** Code's reasons a job's result is risky: each risky tool it used, and a risky template. */
export function riskyReasons(row: Pick<JobRow, "toolsUsed" | "template">): string[] {
  return [
    ...row.toolsUsed
      .filter((tool) => Object.hasOwn(RISKY_TOOLS, tool))
      .map((tool) => `${tool} ${RISKY_TOOLS[tool]}`),
    ...(RISKY_TEMPLATES.includes(row.template) ? [`${row.template} template`] : []),
  ];
}

/** The first input of a restarted run: the lead's failure note, then the brief. */
export const restartInput = (note: string, brief: string): string =>
  `Failure note from the earlier attempt:\n${note}\n\nBrief:\n${brief}`;

/**
 * True when job task `taskId` owns the row: the row names it, or names no task yet. A run the
 * lead restarted no longer owns its row, so its end and its abort leave the new run's row alone.
 */
export const ownsRow = (row: Pick<JobRow, "taskId">, taskId: string): boolean =>
  row.taskId === null || String(row.taskId) === taskId;
export type JobState =
  | { phase: "open" }
  | { phase: "run" }
  | { phase: "notify"; kind: ResultKind }
  | { phase: "await"; wakeAt: number };

export interface JobTaskDeps {
  readonly person: string;
  /** The review task a risky result starts (result-review.ts). */
  readonly review: () => ReviewTask;
  readonly gate: () => BudgetWaiter | undefined;
  readonly timeZone: string;
  /** The extensions a job conversation selects (no tool that starts work). */
  readonly extensions: () => readonly Extension[];
  /**
   * Relay mode (the household agent, which has no lead): the result is stored and the task ends,
   * with no wake notice; each person's lead pulls it from its own board. A risky result is still
   * reviewed first.
   */
  readonly relay?: boolean;
  /** The instructions every job of this task gets in place of its template's (the household agent). */
  readonly instruction?: string;
  /**
   * Called after the commit that starts a job and after each commit that ends one (the capacity
   * watch). It must not throw; nothing the job does waits on what it sends.
   */
  readonly onJobsChanged?: (context: Context) => Promise<void>;
}

const textOf = (message: AssistantMessage | undefined): string =>
  (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

async function rowOf(tx: Tx, n: number): Promise<JobRow> {
  const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
  if (row === undefined) throw new Error(`no job ${n} on the board`);
  return row;
}

/** Configures a job's conversation from its row: the tier's model, the effort, the template. */
export async function configureJob(
  tx: Tx,
  row: Pick<JobRow, "template" | "tier" | "effort" | "conversationId">,
  extensions: readonly Extension[],
  instruction?: string,
): Promise<void> {
  if (row.conversationId === null) return;
  const overrides = (await tx.doc(RoleModelsDoc)).overrides;
  const template = templatesOf((await tx.doc(TemplatesDoc)).custom).find(
    (each) => each.name === row.template,
  );
  await configure(tx, row.conversationId, {
    model: modelRef(tierModelOf(row.tier, overrides)),
    thinkingLevel: row.effort.applied as ModelThinkingLevel,
    extensions,
    instructions: instruction ?? template?.instruction ?? `You are the ${row.template} specialist.`,
  });
}

/**
 * Ends job `n` in one commit: its cost from its conversation's ledger, the result stored as
 * waiting, the row's end, and the done record (key `job:<task id>`, written once).
 */
async function finish(
  tx: Tx,
  deps: JobTaskDeps,
  taskId: string,
  n: number,
  outcome: {
    readonly status: "done" | "failed" | "stopped";
    readonly kind?: ResultKind;
    readonly text?: string;
  },
  at: number,
): Promise<JobRow> {
  const row = await rowOf(tx, n);
  // Every conversation the job used counts: earlier runs and a review too (D-051).
  await recordCost(tx, n, await jobCost(tx, row));
  if (outcome.kind !== undefined) await storeResult(tx, n, outcome.kind, outcome.text ?? "", at);
  await endRow(tx, n, outcome.status, at);
  await appendRecord(
    tx,
    doneRecord({
      key: `job:${taskId}`,
      at,
      agent: row.template,
      label: jobRowLabel(n, row.title),
      reason: outcome.status === "done" ? "answered; waits for the lead" : outcome.status,
      cost: row.cost,
    }),
    deps.timeZone,
  );
  return row;
}

/**
 * The person (or the lead, on the person's ask) resumes stopped or blocked job `n` in the caller's
 * commit: the row is queued again (`resumeStoppedRow`) and a new job task continues the last run's
 * transcript. Not one of the lead's escalations: attempts stay as they are.
 */
export async function resumeJobTask(
  tx: Tx,
  task: JobTask,
  n: number,
  at: number,
  by: "person" | "lead",
): Promise<{ readonly ok: JobRow; readonly taskId: TaskId } | { readonly refused: ResumeRefusal }> {
  const answer = await resumeStoppedRow(tx, n, at, by);
  if ("refused" in answer) return answer;
  const row = answer.ok;
  const taskId = await tx.createTask(
    task,
    { number: n, attempt: row.attempts.restarts, resume: row.resumes },
    { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
  );
  row.taskId = taskId;
  return { ok: row, taskId };
}

/**
 * A resumed run's conversation: a fork of the last run's at its newest entry, owned by the new
 * task, so the run continues with its whole transcript and a later stop reaches it. The fork's
 * spend starts at zero; the job's cost still counts every run. Null when there is nothing to fork.
 */
async function forkLastRun(tx: Tx, row: JobRow, taskId: TaskId) {
  const parent = row.runs.at(-1)?.conversationId ?? null;
  if (parent === null) return null;
  const newest = (await tx.scanEntries({ conversationId: parent }, 1)).items[0];
  if (newest === undefined) return null;
  return tx.forkConversation(parent, newest.id, { ownership: { kind: "task", taskId } });
}

export function createJobTask(deps: JobTaskDeps) {
  const { person } = deps;
  /**
   * One wake notice to the lead, without the result: a follow-up with a request id made from the
   * job and the reason, so a restart sends it once; the commit that sets `wokeAt` ends the task.
   * The lead's answer to it is chat spend, so it waits on the person's limit first.
   */
  const wake = async (
    n: number,
    kind: ResultKind | "late",
    reason: "immediate" | "late",
    runtime: WakeRuntime,
    context: Context,
  ) => {
    await deps
      .gate()
      ?.waitUntilUnder(
        { budget: "person", taskId: String(runtime.taskId), what: `job ${n} result` },
        context,
      );
    const lead = await runtime.conversation(runtime.conversationId, context);
    await lead?.submit(
      {
        type: "input",
        content:
          kind === "late"
            ? `[job ${n} waited 30 minutes: pull it with job_result]`
            : `[job ${n} ${kind}: pull it with job_result]`,
        whenBusy: "followUp",
        requestId: `wake:${n}:${kind}`,
      },
      context,
    );
    let waited = 0;
    let resultKind: string = kind;
    await runtime.commit(async (tx) => {
      const result = (await tx.doc(JobBoardDoc)).jobs[String(n)]?.result;
      if (result !== undefined && result !== null) {
        result.wokeAt ??= runtime.now();
        waited = Math.max(0, runtime.now() - result.at);
        resultKind = result.kind;
      }
      return { status: "terminal", outcome: { status: "completed", result: null } };
    }, context);
    logEvent("job.wake_sent", {
      cell: person,
      job: n,
      kind: resultKind,
      reason,
      waited_ms: waited,
    });
  };
  return defineTask<JobInput, JobState, null>({
    name: JOB_KIND,
    version: 3,
    initial: () => ({ phase: "open" }),
    // A job running at the upgrade is its first attempt; an earlier run is never a resume.
    migrate: (input, checkpoint) => ({
      input: { attempt: 0, ...(input as { number: number }) },
      checkpoint: checkpoint as JobState,
    }),
    phases: {
      open: async (job, runtime, context) => {
        const n = job.input.number;
        let started: JobRow | undefined;
        await runtime.commit(async (tx) => {
          const row = await rowOf(tx, n);
          if (!ownsRow(row, String(job.id))) {
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          const child =
            (job.input.resume === undefined ? null : await forkLastRun(tx, row, job.id)) ??
            (await tx.createConversation({ ownership: { kind: "task", taskId: job.id } }));
          row.conversationId = child.id;
          row.taskId = job.id;
          row.status = "running";
          (await tx.doc(JobBoardDoc)).byConversation[String(child.id)] = n;
          await tx.doc(UsageDoc, child.id);
          await configureJob(tx, row, deps.extensions(), deps.instruction);
          started = { ...row, effort: { ...row.effort } };
          return { status: "running", checkpoint: { phase: "run" } };
        }, context);
        if (started !== undefined) {
          logEvent("job.started", {
            cell: person,
            job: n,
            template: started.template,
            tier: started.tier,
            effort_requested: started.effort.requested,
            effort_applied: started.effort.applied,
            priority: started.priority,
            task_id: String(job.id),
            conversation_id: String(started.conversationId),
            brief_chars: started.brief.length,
          });
          await deps.onJobsChanged?.(context);
        }
      },
      run: async (job, runtime, context) => {
        const n = job.input.number;
        const row = (await runtime.snapshot(JobBoardDoc, context))?.jobs[String(n)];
        if (row !== undefined && !ownsRow(row, String(job.id))) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
          return;
        }
        if (row === undefined || row.conversationId === null) {
          await runtime.commit(async (tx) => {
            await finish(
              tx,
              deps,
              String(job.id),
              n,
              { status: "failed", kind: "failure", text: "the job's conversation is missing" },
              runtime.now(),
            );
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          return;
        }
        // A job still waiting to start 10 minutes after it was created logs one warning.
        let warned = false;
        const queuedLong = () => {
          if (warned) return;
          warned = true;
          logEvent(
            "job.queued_long",
            { cell: person, job: n, queued_ms: Math.max(0, runtime.now() - row.createdAt) },
            "warn",
          );
        };
        const left = row.createdAt + QUEUED_LONG_MS - runtime.now();
        const timer = left > 0 ? setTimeout(queuedLong, left) : undefined;
        timer?.unref?.();
        try {
          await deps.gate()?.waitUntilUnder(
            {
              budget: budgetOf(row.template),
              taskId: String(job.id),
              what: `job ${n} ${row.template}`,
            },
            context,
          );
        } finally {
          clearTimeout(timer);
        }
        if (runtime.now() - row.createdAt >= QUEUED_LONG_MS) queuedLong();
        const conversation = await runtime.conversation(row.conversationId, context);
        if (conversation === undefined) throw new Error(`job ${n}: its conversation is missing`);
        const { attempt, resume } = job.input;
        const last = row.runs.at(-1);
        // A resumed run continues its transcript; the restart's note is the first input of a
        // restarted run only.
        const resumed = resume !== undefined && last !== undefined && last.conversationId !== null;
        const content = resumed
          ? resumeInput(last.endedAt, deps.timeZone)
          : attempt > 0 && last !== undefined && resume === undefined
            ? restartInput(last.note, row.brief)
            : row.brief;
        const submission = await conversation.submit(
          {
            type: "input",
            content,
            whenBusy: "followUp",
            requestId:
              resume !== undefined
                ? `job:${n}:resume:${resume}`
                : attempt > 0
                  ? `job:${n}:${attempt}`
                  : `job:${n}`,
          },
          context,
        );
        const settled = await submission.wait(context);
        let ended:
          | { row: JobRow; kind: ResultKind; chars: number; outcome: string; marked: number }
          | undefined;
        await runtime.commit(async (tx) => {
          // A run the lead restarted while it answered leaves the new run's row alone.
          if (!ownsRow(await rowOf(tx, n), String(job.id))) {
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          let kind: ResultKind = "routine";
          let text: string;
          if (settled.status === "unanswered") {
            kind = "failure";
            text = `the job did not answer: ${settled.reason}`;
          } else if (settled.type !== "input") {
            kind = "failure";
            text = "the job did not answer";
          } else {
            const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
              | AssistantMessage
              | undefined;
            text = textOf(answer);
            if (text.trim() === "") {
              kind = "failure";
              text = "the job answered with nothing";
            }
          }
          // A risky result: a tool that acts, spends, or touches money; the template; the lead.
          const before = await rowOf(tx, n);
          const reasons = riskyReasons(before);
          if (reasons.length > 0) await markRisky(tx, n, { code: reasons });
          if (kind === "routine" && isRisky(before)) kind = "risky";
          // A failure a producer stored first (an escalation) ends the job failed too.
          const prior = before.result?.kind;
          const status = kind === "failure" || prior === "failure" ? "failed" : "done";
          const row = await finish(
            tx,
            deps,
            String(job.id),
            n,
            { status, kind, text },
            runtime.now(),
          );
          // A result a producer stored first (a question, a risky mark) keeps its kind.
          const stored = row.result ?? { kind, at: runtime.now() };
          ended = {
            row: { ...row },
            kind: stored.kind,
            chars: text.length,
            outcome: status === "done" ? "answered" : "failed",
            marked: reasons.length,
          };
          // A risky result is reviewed first; the review wakes the lead when it is done.
          if (stored.kind === "risky" && status === "done") {
            await startReview(tx, deps.review(), n);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          if (deps.relay === true) {
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          const next: JobState =
            stored.kind === "routine"
              ? { phase: "await", wakeAt: stored.at + RESULT_WAKE_MS }
              : { phase: "notify", kind: stored.kind };
          return { status: "running", checkpoint: next };
        }, context);
        if (ended !== undefined && ended.marked > 0) {
          logEvent("job.risky_marked", { cell: person, job: n, by: "code", reasons: ended.marked });
        }
        if (ended !== undefined) {
          logEvent("job.finished", {
            cell: person,
            job: n,
            template: ended.row.template,
            tier: ended.row.tier,
            outcome: ended.outcome,
            cost_usd: ended.row.cost,
            duration_ms: Math.max(0, runtime.now() - ended.row.createdAt),
          });
          logEvent("job.result_waiting", {
            cell: person,
            job: n,
            kind: ended.kind,
            result_chars: ended.chars,
          });
          await deps.onJobsChanged?.(context);
        }
      },
      notify: async (job, runtime, context) => {
        const { kind } = job.state.checkpoint;
        await wake(job.input.number, kind, "immediate", runtime, context);
      },
      await: async (job, runtime, context) => {
        const n = job.input.number;
        await runtime.sleep(job.state.checkpoint.wakeAt, context);
        const pulled = (await runtime.snapshot(JobBoardDoc, context))?.jobs[String(n)]?.result;
        if (pulled === undefined || pulled === null || pulled.pulledAt !== null) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
          return;
        }
        await wake(n, "late", "late", runtime, context);
      },
    },
    abort: async (job, runtime, context) => {
      const n = job.input.number;
      let row: JobRow | undefined;
      await runtime.commit(async (tx) => {
        const current = (await tx.doc(JobBoardDoc)).jobs[String(n)];
        if (
          current !== undefined &&
          !ENDED.has(current.status) &&
          ownsRow(current, String(job.id))
        ) {
          row = {
            ...(await finish(tx, deps, String(job.id), n, { status: "stopped" }, runtime.now())),
          };
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
      if (row !== undefined) {
        logEvent("job.finished", {
          cell: person,
          job: n,
          template: row.template,
          tier: row.tier,
          outcome: "stopped",
          cost_usd: row.cost,
          duration_ms: Math.max(0, runtime.now() - row.createdAt),
        });
        await deps.onJobsChanged?.(withoutAbortSignal(context));
      }
    },
  });
}

export type JobTask = ReturnType<typeof createJobTask>;

/** What a wake notice needs of a task invocation. */
type WakeRuntime = Pick<
  TaskRuntime<JobInput, JobState, null, object>,
  "taskId" | "conversationId" | "conversation" | "commit" | "now"
>;
