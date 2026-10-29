/**
 * The job gate: before each model step of a job, code bounds the job (C3, D-035). The lead decides
 * how to escalate; this extension only stops a job at its bounds:
 *
 * - **Cap.** The job's cost is the sum over every conversation it used (D-051). When the cost is at
 *   the cap of its current tier, or the next step (projected as the largest step so far) would pass
 *   it, the job pauses before the request.
 * - **Loop guard.** Three failing steps in a row (loop-guard.ts) pause the job.
 *
 * A pause commits `paused` with its reason, sends the lead one wake notice, and waits on the job's
 * hold (job-holds.ts) with no request and no spend until the lead raises or restarts the job. After
 * a restart of the cell the hook runs again, reads the paused row, and waits again.
 *
 * A job the content check blocked takes no step: its task is stopped here when the cell went
 * down between the block and the stop.
 *
 * An empty or cut-off final answer is continued with a fixed nudge (`onYield`), so the next
 * request's messages show it and the third pauses the job instead of ending it.
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  type DocumentReader,
  defineExtension,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  ROOT_CONVERSATION_ID,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, type JobRow } from "./docs.ts";
import { ENDED, jobConversations, pauseRow, shownCost } from "./job-board.ts";
import type { JobHolds } from "./job-holds.ts";
import { failingStreak, projectNext } from "./loop-guard.ts";
import { conversationTotal } from "./month-ledger.ts";
import { EMPTY_REPLY_NUDGE, LOOP_LIMIT } from "./release-defaults.ts";
import { jobOf } from "./telemetry.ts";

export interface JobGateDeps {
  readonly person: string;
  readonly harness: () => Harness;
  readonly holds: JobHolds;
  readonly now: () => number;
  /** The household agent: no lead to notify of a pause; the pause shows on both people's boards. */
  readonly relay?: boolean;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** A job's cost now, from committed reads: every conversation it used. */
export async function jobCostOf(
  reader: Pick<DocumentReader, "snapshot">,
  row: Pick<JobRow, "conversationId" | "runs" | "review">,
  context: Context,
): Promise<number> {
  const states = await Promise.all(
    jobConversations(row).map((id) => reader.snapshot(UsageDoc, id, context)),
  );
  return states.reduce((total, state) => total + conversationTotal(state), 0);
}

/**
 * The board with each job's cost as shown (shownCost): a live job's is read from its ledgers. It
 * runs on every lead prompt and board read, so every job's reads go out at once.
 */
export async function withLiveCosts<B extends { readonly jobs: Readonly<Record<string, JobRow>> }>(
  reader: Pick<DocumentReader, "snapshot">,
  board: B,
  context: Context,
): Promise<B> {
  const entries = await Promise.all(
    Object.entries(board.jobs).map(async ([key, row]) => {
      const cost = await shownCost(row, () => jobCostOf(reader, row, context));
      return [key, cost === row.cost ? row : { ...row, cost }] as const;
    }),
  );
  return { ...board, jobs: Object.fromEntries(entries) as Record<string, JobRow> };
}

/** The wake notice of a paused job, as the lead reads it. */
export const pauseNotice = (n: number, reason: "cap" | "loop"): string =>
  `[job ${n} paused: ${reason === "cap" ? "cap reached" : `same step failed ${LOOP_LIMIT} times`}; choose set_job or restart_job]`;

/**
 * A job conversation may not take a step: its job is paused or waits for an answer, or it is not
 * the job's current run (an ended job, or a run the lead restarted, whose task is being aborted).
 */
const held = (row: JobRow | undefined, conversationId: string) =>
  row === undefined ||
  row.status === "paused" ||
  row.status === "waiting" ||
  ENDED.has(row.status) ||
  String(row.conversationId) !== conversationId;

/** An empty answer (no text) or one the model cut off at its output limit. */
export const emptyOrCut = (answer: AssistantMessage): boolean =>
  answer.stopReason === "length" ||
  answer.content.every((part) => part.type !== "text" || part.text.trim() === "");

export function createJobGate(deps: JobGateDeps): Extension {
  const { person, harness, holds, now } = deps;
  /** Job tasks this process already asked to stop for a block. */
  const stopped = new Set<string>();
  const rowOf = async (n: number, context: Context) =>
    (await harness().snapshot(JobBoardDoc, context))?.jobs[String(n)];

  /** One wake notice per pause: the request id is made from the job and the pause's time. */
  const notify = async (row: JobRow, context: Context) => {
    if (row.pause === null || deps.relay === true) return;
    const lead = await harness().conversation(ROOT_CONVERSATION_ID, context);
    await lead?.submit(
      {
        type: "input",
        content: pauseNotice(row.number, row.pause.reason),
        whenBusy: "followUp",
        requestId: `pause:${row.number}:${row.pause.at}:${row.pause.reason}`,
      },
      withoutAbortSignal(context),
    );
  };

  const check = async (
    n: number,
    conversationId: string,
    messages: readonly Message[],
    context: Context,
  ): Promise<"go" | "held"> => {
    const row = await rowOf(n, context);
    if (row === undefined) return "go";
    if (held(row, conversationId)) return "held";
    const cost = await jobCostOf(harness(), row, context);
    const projected = projectNext(messages);
    const streak = failingStreak(messages, row.resumedAt ?? 0);
    const reason =
      cost >= row.cap || cost + projected > row.cap
        ? "cap"
        : streak >= LOOP_LIMIT
          ? "loop"
          : undefined;
    if (reason === undefined) return "go";
    const detail =
      reason === "cap"
        ? `${usd(cost)} of ${usd(row.cap)}; next step about ${usd(projected)}`
        : `same step failed ${streak} times`;
    const paused = await harness().commit(async (tx) => {
      const current = (await tx.doc(JobBoardDoc)).jobs[String(n)];
      if (current !== undefined) current.cost = Math.max(current.cost, cost);
      return pauseRow(tx, n, reason, detail, now());
    }, context);
    if (paused) {
      logEvent("job.paused", {
        cell: person,
        job: n,
        reason,
        cost_usd: cost,
        cap_usd: row.cap,
        streak,
      });
    }
    return "held";
  };

  return defineExtension({
    name: "secbot-job-gate",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          if (api.conversationId === ROOT_CONVERSATION_ID) return undefined;
          const n = await jobOf(api, api.conversationId, context);
          if (n === null) return undefined;
          const self = String(api.conversationId);
          // The content check blocked this run and the cell went down before the job's task was
          // stopped: stop it now, before any further step.
          const first = await rowOf(n, context);
          if (
            first?.status === "blocked" &&
            String(first.conversationId) === self &&
            first.taskId !== null &&
            !stopped.has(String(first.taskId))
          ) {
            stopped.add(String(first.taskId));
            await harness().abortTask(first.taskId, withoutAbortSignal(context));
          }
          for (;;) {
            if ((await check(n, self, request.messages, context)) === "go") return undefined;
            const row = await rowOf(n, context);
            if (row?.status === "paused") await notify(row, context);
            await holds.waitWhile(n, async () => held(await rowOf(n, context), self), context);
          }
        },
        onYield: async (answer, api, context) => {
          if (api.conversationId === ROOT_CONVERSATION_ID) return undefined;
          if ((await jobOf(api, api.conversationId, context)) === null) return undefined;
          return emptyOrCut(answer) ? { continue: EMPTY_REPLY_NUDGE } : undefined;
        },
      }),
    ],
  });
}
