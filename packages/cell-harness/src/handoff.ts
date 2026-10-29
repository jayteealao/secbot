/**
 * The retired hand-off. The lead starts jobs now (lead-tools.ts, job-task.ts); what stays here is
 * what a cell upgraded with a hand-off in flight needs to finish it once: the specialists' anchor
 * task and the reporter that delivers a brief and posts the `[handoff <name> answered]` follow-up.
 *
 * Adapted from pi-durable v1.0.3 test/examples/23-subagent-background.ts (MIT, Earendil Works):
 * the `Anchor` and `Reporter` background tasks.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  defineExtension,
  defineTask,
  type Extension,
} from "@earendil-works/pi-durable";
import { appendRecord } from "./activity.ts";
import type { BudgetWaiter } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import { RosterDoc } from "./docs.ts";
import {
  doneRecord,
  endJob,
  handoffWhat,
  jobLabel,
  markJobStart,
  REPORTER_KIND,
  takeJobCost,
} from "./jobs.ts";
import { budgetOf } from "./month-ledger.ts";

/** A follow-up the lead receives starts with this, then the specialist's name and the outcome. */
export const HANDOFF_REPORT_PREFIX = "[handoff ";

/** Owns one specialist conversation; a background task that finishes at once. */
export const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "secbot.specialist-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  brief: string;
  startedAt: number;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string; outcome: string };

/**
 * Delivers one brief to a specialist, waits for its answer, and posts the answer to the lead as a
 * follow-up input. Both submissions carry request ids made from this task's id, and the answer id
 * is recorded in the roster in the same commit that decides the report, so a restart delivers once
 * and reports once.
 *
 * Above a limit both phases wait first (budget-gate.ts): the brief waits on the specialist's budget
 * (the developer budget for the developer specialist, the person's limit for the others), and the
 * report waits on the person's limit. A restart reruns the phase, which checks again.
 *
 * The job in activity (jobs.ts): the delivery marks the specialist's ledger total, the settle
 * commit takes the job's cost, and the commit that ends the task writes the done record (key
 * `job:<task id>`) in the cell's time zone, so a finished job is recorded once.
 */
export function createReporter(
  person: string,
  gate: () => BudgetWaiter | undefined = () => undefined,
  timeZone = "UTC",
) {
  const done = async (
    tx: Parameters<typeof appendRecord>[0],
    reporter: { readonly id: unknown; readonly input: ReporterInput },
    at: number,
    reason: string,
  ) => {
    const taskId = String(reporter.id);
    await appendRecord(
      tx,
      doneRecord({
        key: `job:${taskId}`,
        at,
        agent: reporter.input.name,
        label: jobLabel(handoffWhat(reporter.input.name, reporter.input.brief)),
        reason,
        cost: await endJob(tx, taskId),
      }),
      timeZone,
    );
  };
  return defineTask<ReporterInput, ReporterState, null>({
    name: REPORTER_KIND,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, brief } = reporter.input;
        await gate()?.waitUntilUnder(
          {
            budget: budgetOf(name),
            taskId: String(reporter.id),
            what: handoffWhat(name, brief),
          },
          context,
        );
        const specialist = await runtime.conversation(conversationId, context);
        if (specialist === undefined) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                phase: "report",
                report: `${HANDOFF_REPORT_PREFIX}${name} failed: the specialist's conversation is missing]`,
                outcome: "failed",
              },
            }),
            context,
          );
          return;
        }
        await runtime.commit(async (tx) => {
          await markJobStart(tx, String(reporter.id), conversationId);
          return undefined;
        }, context);
        const submission = await specialist.submit(
          {
            type: "input",
            content: brief,
            whenBusy: "followUp",
            requestId: `handoff:${reporter.id}`,
          },
          context,
        );
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          await takeJobCost(tx, String(reporter.id), name, conversationId);
          const next = (outcome: string, report?: string) => {
            const checkpoint: ReporterState =
              report === undefined
                ? { phase: "report", outcome }
                : { phase: "report", report, outcome };
            return { status: "running", checkpoint } as const;
          };
          if (settled.status === "unanswered") {
            return settled.reason === "aborted"
              ? next("aborted")
              : next("failed", `${HANDOFF_REPORT_PREFIX}${name} failed: ${settled.reason}]`);
          }
          if (settled.type !== "input") return next("nothing");
          const record = (await tx.doc(RosterDoc)).specialists[name];
          if (record === undefined) return next("nothing");
          if (record.reported.includes(settled.answer)) return next("already_reported");
          record.reported.push(settled.answer);
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
            | AssistantMessage
            | undefined;
          return next("reported", `${HANDOFF_REPORT_PREFIX}${name} answered] ${textOf(answer)}`);
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const { report, outcome } = reporter.state.checkpoint;
        if (report !== undefined) {
          await gate()?.waitUntilUnder(
            {
              budget: "person",
              taskId: String(reporter.id),
              what: `handoff ${reporter.input.name} report`,
            },
            context,
          );
          const lead = await runtime.conversation(runtime.conversationId, context);
          await lead?.submit(
            {
              type: "input",
              content: report,
              whenBusy: "followUp",
              requestId: `handoff-report:${reporter.id}`,
            },
            context,
          );
        }
        await runtime.commit(async (tx) => {
          await done(tx, reporter, runtime.now(), outcomeText(outcome, report));
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        logEvent("handoff.reported", {
          cell: person,
          specialist: reporter.input.name,
          reporter_task_id: reporter.id,
          outcome,
          duration_ms: Date.now() - reporter.input.startedAt,
        });
      },
    },
    abort: (reporter, runtime, context) =>
      runtime.commit(async (tx) => {
        const { name, conversationId } = reporter.input;
        await takeJobCost(tx, String(reporter.id), name, conversationId);
        await done(tx, reporter, runtime.now(), "stopped");
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}

/** A finished hand-off's outcome, as its done record says it. */
function outcomeText(outcome: string, report: string | undefined): string {
  if (outcome === "reported") return "answered the lead";
  if (outcome === "aborted") return "stopped";
  if (outcome === "failed") {
    const why = /failed: (.*)\]$/.exec(report ?? "")?.[1];
    return why === undefined ? "failed" : `failed: ${why}`;
  }
  return "no answer";
}

/**
 * The retired hand-off's tasks with no tool: registered so a reporter started before an upgrade
 * still delivers and reports once, and the specialists' anchor tasks still resolve.
 */
export function createLegacyHandoffExtension(
  person: string,
  gate: () => BudgetWaiter | undefined = () => undefined,
  timeZone = "UTC",
): Extension {
  return defineExtension({
    name: "secbot-handoff",
    tasks: [Anchor, createReporter(person, gate, timeZone)],
  });
}
