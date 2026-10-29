/**
 * The tools a job conversation has beside its template's: ask the lead a question and wait for the
 * answer, ask the lead for a new job, and search the transcripts of its own earlier attempts after
 * a restart. A job has no tool that starts a subagent: a requested job is a row on the lead's board
 * that only the lead can start.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type Harness,
  ROOT_CONVERSATION_ID,
  type ToolRegistration,
  type Wrap,
  wrapTool,
} from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, type JobQuestion, TemplatesDoc } from "./docs.ts";
import { type HistoryHit, searchHistoryWindow } from "./history-search.ts";
import { askQuestion, createJobRow } from "./job-board.ts";
import type { JobHolds } from "./job-holds.ts";
import { DEFAULT_JOB_EFFORT } from "./release-defaults.ts";
import { jobOf } from "./telemetry.ts";
import { templateNamed, templatesOf } from "./templates.ts";

export interface JobToolsDeps {
  readonly person: string;
  readonly harness: () => Harness;
  readonly holds: JobHolds;
  readonly now: () => number;
  /** Every other tool a job conversation has: each call is recorded on the job's row. */
  readonly wrapped: readonly string[];
  /**
   * The household agent's jobs: no lead to ask, so no `ask_lead` and no `request_job`; searching
   * the job's own earlier attempts and the tools-used marks stay.
   */
  readonly household?: boolean;
}

/**
 * Records a tool's name on the calling job's row, in the tool's own commit before the tool runs
 * (a hook cannot write), so a risky tool marks the result even when the call fails or the cell
 * stops right after it. A call from any other conversation runs unchanged.
 */
export function toolsUsedWraps(names: readonly string[]): Wrap[] {
  return names.map((name) =>
    // Only the name of the first argument is read: the wrapper decorates whichever tool won.
    wrapTool({ name } as ToolRegistration, (inner) => ({
      ...inner,
      execute: async (args, api, context) => {
        const n = await jobOf(api, api.conversationId, context);
        if (n !== null) {
          await api.commit(async (tx) => {
            const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
            if (row === undefined || String(row.conversationId) !== String(api.conversationId)) {
              return;
            }
            if (!row.toolsUsed.includes(name)) row.toolsUsed.push(name);
          }, context);
        }
        return inner.execute(args, api, context);
      },
    })),
  );
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const refusal = (value: string) => ({ ...text(value), isError: true });

/** The longest question a job can ask. */
export const QUESTION_MAX_CHARS = 1_000;

/** The lead's wake notice for a job's question. */
export const questionNotice = (n: number) =>
  `[job ${n} question: read it with read_job; answer with answer_job]`;

/** The lead's wake notice for a job's request for a new job. */
export const requestNotice = (n: number, m: number) =>
  `[job ${n} asks for a new job: job ${m}; start it with start_job request ${m} or leave it]`;

/** The answer as the job reads it. */
const answerText = (question: JobQuestion) =>
  `The ${question.answeredBy ?? "lead"} answers: ${question.answer ?? ""}`;

export function createJobToolsExtension(deps: JobToolsDeps): Extension {
  const askLead = defineTool({
    name: "ask_lead",
    description:
      "Ask the lead one question when the brief leaves out something you need and cannot find yourself. You wait, with no spend, until it is answered; the answer is this tool's result.",
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        maxLength: QUESTION_MAX_CHARS,
        description: "One self-contained question.",
      }),
    }),
    // Run again after a crash, it finds the question it asked and waits again.
    replay: "safe",
    execute: async (args, api, context) => {
      const n = await jobOf(api, api.conversationId, context);
      if (n === null) return refusal("Only a job can ask the lead.");
      const asked = await api.commit(async (tx) => {
        const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
        if (row === undefined || String(row.conversationId) !== String(api.conversationId)) {
          return null;
        }
        // The same question answered already (the call ran again after a crash): its answer.
        const last = row.question;
        if (
          last !== null &&
          last.from === "job" &&
          last.answer !== null &&
          last.text === args.question
        ) {
          return { question: { ...last }, fresh: false };
        }
        const open = last !== null && last.answer === null;
        return { question: await askQuestion(tx, n, args.question, deps.now()), fresh: !open };
      }, context);
      if (asked === null) return refusal("This job's run has ended.");
      const { number } = asked.question;
      if (asked.question.answer === null) {
        const lead = await deps.harness().conversation(ROOT_CONVERSATION_ID, context);
        await lead?.submit(
          {
            type: "input",
            content: questionNotice(n),
            whenBusy: "followUp",
            requestId: `question:${n}:${number}`,
          },
          context,
        );
        if (asked.fresh) {
          logEvent("job.question_asked", {
            cell: deps.person,
            job: n,
            to_person: false,
            question_chars: args.question.length,
          });
        }
      }
      const current = async () => {
        const question = (await api.snapshot(JobBoardDoc, context))?.jobs[String(n)]?.question;
        return question?.number === number ? question : null;
      };
      await deps.holds.waitWhile(
        n,
        async () => {
          const question = await current();
          return question !== null && question.answer === null;
        },
        context,
      );
      const answered = await current();
      if (answered === null || answered.answer === null) {
        return refusal("The question was withdrawn; go on with what you have.");
      }
      return { ...text(answerText(answered)), details: { question: number } };
    },
  });
  const searchOldJob = defineTool({
    name: "search_old_job",
    description:
      "Search the transcripts of this job's earlier attempts (after the lead restarted it), newest attempt first. Every word of the query must appear.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Words to look for." }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: "At most this many (default 10)." }),
      ),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async (args, api, context) => {
      const n = await jobOf(api, api.conversationId, context);
      if (n === null) return refusal("Only a job can search its earlier attempts.");
      const row = (await api.snapshot(JobBoardDoc, context))?.jobs[String(n)];
      const runs = [...(row?.runs ?? [])].reverse();
      if (runs.length === 0) return text("This job has no earlier attempt.");
      const limit = args.limit ?? 10;
      const found: string[] = [];
      for (const [index, run] of runs.entries()) {
        if (run.conversationId === null || found.length >= limit) continue;
        const result = await searchHistoryWindow(
          deps.harness(),
          args.query,
          { limit: limit - found.length, conversationId: run.conversationId },
          context,
        );
        const attempt = runs.length - index;
        for (const hit of result.hits as HistoryHit[]) {
          found.push(`attempt ${attempt} #${hit.entryId} ${hit.role}: ${hit.text}`);
        }
      }
      return {
        ...text(
          found.length === 0
            ? `No messages of this job's earlier attempts match "${args.query}".`
            : found.join("\n\n"),
        ),
        details: { matches: found.length },
      };
    },
  });
  const requestJob = defineTool({
    name: "request_job",
    description:
      "Ask the lead for a new job when this one needs work you cannot do yourself. It is added to the lead's job board and the lead decides whether to start it; you go on with your own job.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 80, description: "A few words on the job." }),
      brief: Type.String({ minLength: 1, description: "A self-contained brief." }),
      template: Type.String({ description: "The template's name." }),
    }),
    // A crash mid-call gives an interrupted result instead of a second request.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const n = await jobOf(api, api.conversationId, context);
      if (n === null) return refusal("Only a job can ask for a new job.");
      const requested = await api.commit(async (tx) => {
        const template = templateNamed(
          templatesOf((await tx.doc(TemplatesDoc)).custom),
          args.template,
        );
        if ("error" in template) return template;
        const row = await createJobRow(tx, {
          title: args.title.trim(),
          brief: args.brief,
          priority: "routine",
          deadline: null,
          template: template.name,
          tier: template.tier,
          effort: { requested: DEFAULT_JOB_EFFORT, applied: DEFAULT_JOB_EFFORT },
          owner: deps.person,
          turn: null,
          createdAt: deps.now(),
        });
        row.requestedBy = n;
        return { number: row.number };
      }, context);
      if ("error" in requested) return refusal(requested.error);
      const m = requested.number;
      const lead = await deps.harness().conversation(ROOT_CONVERSATION_ID, context);
      await lead?.submit(
        {
          type: "input",
          content: requestNotice(n, m),
          whenBusy: "followUp",
          requestId: `request:${n}:${m}`,
        },
        context,
      );
      logEvent("job.requested", {
        cell: deps.person,
        job: m,
        by_job: n,
        brief_chars: args.brief.length,
      });
      return {
        ...text(
          `job ${m} is on the lead's board; the lead decides whether to start it. Go on with your own job.`,
        ),
        details: { job: m },
      };
    },
  });

  const tools = deps.household === true ? [searchOldJob] : [askLead, requestJob, searchOldJob];
  return defineExtension({
    name: "secbot-job-tools",
    tools,
    wraps: toolsUsedWraps([...deps.wrapped, ...tools.map((tool) => tool.name)]),
  });
}
