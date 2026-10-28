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
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineTask,
  type Extension,
  type TaskRuntime,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { appendRecord } from "./activity.ts";
import type { BudgetWaiter } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, type JobRow, type ResultKind, RoleModelsDoc, TemplatesDoc } from "./docs.ts";
import { ENDED, endRow, recordCost, storeResult } from "./job-board.ts";
import { doneRecord, jobRowLabel } from "./jobs.ts";
import { modelRef } from "./model-map.ts";
import { budgetOf, conversationTotal } from "./month-ledger.ts";
import { RESULT_WAKE_MS } from "./release-defaults.ts";
import { templatesOf, tierModelOf } from "./templates.ts";

/** The job task's kind. */
export const JOB_KIND = "secbot.job";

export type JobInput = { number: number };
export type JobState =
  | { phase: "open" }
  | { phase: "run" }
  | { phase: "notify"; kind: ResultKind }
  | { phase: "await"; wakeAt: number };

export interface JobTaskDeps {
  readonly person: string;
  readonly gate: () => BudgetWaiter | undefined;
  readonly timeZone: string;
  /** The extensions a job conversation selects (no tool that starts work). */
  readonly extensions: () => readonly Extension[];
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
    instructions: template?.instruction ?? `You are the ${row.template} specialist.`,
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
  if (row.conversationId !== null) {
    await recordCost(tx, n, conversationTotal(await tx.doc(UsageDoc, row.conversationId)));
  }
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
    version: 1,
    initial: () => ({ phase: "open" }),
    phases: {
      open: async (job, runtime, context) => {
        const n = job.input.number;
        let started: JobRow | undefined;
        await runtime.commit(async (tx) => {
          const row = await rowOf(tx, n);
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: job.id },
          });
          row.conversationId = child.id;
          row.taskId = job.id;
          row.status = "running";
          (await tx.doc(JobBoardDoc)).byConversation[String(child.id)] = n;
          await tx.doc(UsageDoc, child.id);
          await configureJob(tx, row, deps.extensions());
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
        }
      },
      run: async (job, runtime, context) => {
        const n = job.input.number;
        const row = (await runtime.snapshot(JobBoardDoc, context))?.jobs[String(n)];
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
        await deps.gate()?.waitUntilUnder(
          {
            budget: budgetOf(row.template),
            taskId: String(job.id),
            what: `job ${n} ${row.template}`,
          },
          context,
        );
        const conversation = await runtime.conversation(row.conversationId, context);
        if (conversation === undefined) throw new Error(`job ${n}: its conversation is missing`);
        const submission = await conversation.submit(
          { type: "input", content: row.brief, whenBusy: "followUp", requestId: `job:${n}` },
          context,
        );
        const settled = await submission.wait(context);
        let ended: { row: JobRow; kind: ResultKind; chars: number; outcome: string } | undefined;
        await runtime.commit(async (tx) => {
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
          const status = kind === "failure" ? "failed" : "done";
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
          };
          const next: JobState =
            stored.kind === "routine"
              ? { phase: "await", wakeAt: stored.at + RESULT_WAKE_MS }
              : { phase: "notify", kind: stored.kind };
          return { status: "running", checkpoint: next };
        }, context);
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
        if (current !== undefined && !ENDED.has(current.status)) {
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
