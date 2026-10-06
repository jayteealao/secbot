/**
 * Hand-off: the only way a message reaches a specialist. The lead model calls the `handoff` tool
 * with a brief it wrote; nothing in the worker or the CLI routes a message.
 *
 * Adapted from pi-durable v1.0.3 test/examples/23-subagent-background.ts (MIT, Earendil Works):
 * the `Anchor` and `Reporter` background tasks. Changes: one tool with only a specialist and a
 * brief (no spawn, stop, or status actions), specialists created by the roster, and the reported
 * answers recorded in the cell's `secbot.specialists` session document.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  defineExtension,
  defineTask,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { RosterDoc } from "./docs.ts";

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
 */
export function createReporter(person: string) {
  return defineTask<ReporterInput, ReporterState, null>({
    name: "secbot.handoff-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, brief } = reporter.input;
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
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
        logEvent("handoff.reported", {
          cell: person,
          specialist: reporter.input.name,
          reporter_task_id: reporter.id,
          outcome,
          duration_ms: Date.now() - reporter.input.startedAt,
        });
      },
    },
    abort: (_reporter, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

/** The lead's `handoff` tool and the tasks behind it. Selected by the lead only. */
export function createHandoffExtension(person: string): Extension {
  const Reporter = createReporter(person);
  const handoff = defineTool({
    name: "handoff",
    description:
      "Brief one of your specialists to work on something in the background. Write a self-contained brief in your own words: what to find out or do, and what the person needs. The tool returns at once; the specialist's answer arrives later as a message that starts with [handoff <name> answered].",
    parameters: Type.Object({
      specialist: Type.String({
        description: "The specialist's name, from the list of specialists.",
      }),
      brief: Type.String({ minLength: 1, description: "The brief, written by you." }),
    }),
    // A crash mid-call gives the model an interrupted result instead of sending a second brief.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const result = await api.commit(async (tx) => {
        const roster = await tx.doc(RosterDoc);
        const record = Object.hasOwn(roster.specialists, args.specialist)
          ? roster.specialists[args.specialist]
          : undefined;
        if (record === undefined) {
          return {
            error: `No specialist named ${args.specialist}. Specialists: ${Object.keys(roster.specialists).join(", ")}.`,
          };
        }
        const input = {
          name: args.specialist,
          conversationId: record.conversationId,
          brief: args.brief,
          startedAt: Date.now(),
        };
        const reporter = await tx.createTask(Reporter, input, {
          ownership: { kind: "conversation" },
          background: true,
        });
        roster.reporters[String(api.taskId)] = reporter;
        return { reporter };
      }, context);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      logEvent("handoff.started", {
        cell: person,
        specialist: args.specialist,
        reporter_task_id: result.reporter,
        brief_chars: args.brief.length,
      });
      return {
        content: [
          {
            type: "text",
            text: `Briefed ${args.specialist}; the answer will follow as a message.`,
          },
        ],
        details: { specialist: args.specialist, reporterTaskId: result.reporter },
      };
    },
  });
  return defineExtension({ name: "secbot-handoff", tools: [handoff], tasks: [Anchor, Reporter] });
}
