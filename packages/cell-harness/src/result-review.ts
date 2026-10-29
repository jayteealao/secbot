/**
 * The result reviewer (C4, D-017, D-050): a risky result passes a reviewer subagent on a model
 * different from every model the job ran on before the lead can pull it. The review runs in its
 * own background task, owned by the lead's conversation, so no lead tool waits for it (AC-9).
 *
 * The task's first commit creates a task-owned reviewer conversation with no tools and the review
 * instructions, and records the review as running on the job's row (its conversation is one of the
 * job's, so its cost counts on the row and in the month ledger). It submits the brief and the
 * result inside an untrusted block, reads one strict JSON verdict (anything else rejects), and in
 * one commit stores the verdict and its reason; a rejection sets the row `rejected`. Then it wakes
 * the lead once: a passed result waits to be pulled, a rejection goes to the escalation rules.
 */
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineTask,
  type Extension,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, type JobRow, RoleModelsDoc } from "./docs.ts";
import { jobConversations, jobCost, recordCost } from "./job-board.ts";
import { modelRef } from "./model-map.ts";
import { redactText } from "./redact.ts";
import {
  DEFAULT_REVIEWER_MODEL,
  RESULT_REVIEW_PROMPT,
  REVIEWER_ROLE,
  type Tier,
} from "./release-defaults.ts";
import { onlyObject, untrustedJson } from "./reviewer.ts";
import { tierModelOf } from "./templates.ts";

/** The review task's kind. */
export const REVIEW_KIND = "secbot.result-review";

/** The reason stored when the reviewer gave anything but one clear verdict. */
export const NO_CLEAR_VERDICT = "the reviewer gave no clear verdict";

const REASON_LIMIT = 200;

/** True when `model` is one the job ran on (a usage key is `provider/modelId`). */
const ranOn = (jobModels: readonly string[], model: string) =>
  jobModels.some((used) => used === model || used.endsWith(`/${model}`));

/**
 * The reviewer's model (D-050): the reviewer role's model unless the job ran on it; then the
 * frontier tier's model; then the mid tier's; then the cheap tier's. Owner changes of the role and
 * the tiers are honoured; a model the job ran on is never chosen while another is left.
 */
export function reviewModelFor(
  jobModels: readonly string[],
  reviewerModel: string,
  tierModels: Readonly<Record<Tier, string>>,
): string {
  const candidates = [reviewerModel, tierModels.frontier, tierModels.mid, tierModels.cheap];
  return candidates.find((model) => !ranOn(jobModels, model)) ?? reviewerModel;
}

/** The review's user message: the brief, then the result inside the untrusted block. */
export function reviewInput(row: Pick<JobRow, "brief">, result: string): string {
  return [
    "Brief:",
    row.brief,
    "",
    "<untrusted-result>",
    untrustedJson(result),
    "</untrusted-result>",
  ].join("\n");
}

/** Reads the verdict strictly: one JSON object with pass or reject and a reason. */
export function readReviewVerdict(text: string): {
  readonly verdict: "pass" | "reject";
  readonly reason: string;
} {
  const value = onlyObject(text);
  const verdict = value?.verdict;
  const reason = typeof value?.reason === "string" ? value.reason.replace(/\s+/g, " ").trim() : "";
  if ((verdict !== "pass" && verdict !== "reject") || reason === "") {
    return { verdict: "reject", reason: NO_CLEAR_VERDICT };
  }
  const short = reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT - 1)}…` : reason;
  return { verdict, reason: redactText(short) };
}

/** Every model a job's conversations spent on, as `pi.usage` keys, and its current tier's. */
async function modelsOfJob(tx: Tx, row: JobRow, overrides: Record<string, string>) {
  const models = new Set<string>([tierModelOf(row.tier, overrides)]);
  for (const id of jobConversations({ ...row, review: null })) {
    for (const key of Object.keys((await tx.doc(UsageDoc, id)).models)) models.add(key);
  }
  return [...models];
}

/** Starts the review of job `n`'s stored result, in the caller's commit (once per result). */
export async function startReview(tx: Tx, task: ReviewTask, n: number): Promise<boolean> {
  const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
  if (row === undefined || row.result === null || row.review?.status === "running") return false;
  if (row.review !== null && row.review.at >= row.result.at) return false;
  await tx.createTask(
    task,
    { number: n },
    { ownership: { kind: "conversation" }, background: true },
  );
  return true;
}

export interface ReviewTaskDeps {
  readonly person: string;
  readonly now: () => number;
  /** The reviewer conversation's extensions: no tools (the budget wait and telemetry only). */
  readonly extensions: () => readonly Extension[];
  /** Relay mode (the household agent, which has no lead): the verdict is stored, with no wake. */
  readonly relay?: boolean;
}

type ReviewState = { phase: "open" } | { phase: "run" } | { phase: "notify"; passed: boolean };

const textOf = (message: AssistantMessage | undefined): string =>
  (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

export function createReviewTask(deps: ReviewTaskDeps) {
  const { person } = deps;
  const terminal = { status: "terminal", outcome: { status: "completed", result: null } } as const;
  return defineTask<{ number: number }, ReviewState, null>({
    name: REVIEW_KIND,
    version: 1,
    initial: () => ({ phase: "open" }),
    phases: {
      open: async (task, runtime, context) => {
        const n = task.input.number;
        await runtime.commit(async (tx) => {
          const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
          if (row === undefined || row.result === null) return terminal;
          const overrides = (await tx.doc(RoleModelsDoc)).overrides;
          const reviewer = Object.hasOwn(overrides, REVIEWER_ROLE)
            ? (overrides[REVIEWER_ROLE] ?? DEFAULT_REVIEWER_MODEL)
            : DEFAULT_REVIEWER_MODEL;
          const model = reviewModelFor(await modelsOfJob(tx, row, overrides), reviewer, {
            cheap: tierModelOf("cheap", overrides),
            mid: tierModelOf("mid", overrides),
            frontier: tierModelOf("frontier", overrides),
          });
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: task.id },
          });
          (await tx.doc(JobBoardDoc)).byConversation[String(child.id)] = n;
          await tx.doc(UsageDoc, child.id);
          await configure(tx, child.id, {
            model: modelRef(model),
            thinkingLevel: "medium" as ModelThinkingLevel,
            extensions: deps.extensions(),
            instructions: RESULT_REVIEW_PROMPT,
          });
          row.review = {
            status: "running",
            model,
            reason: "",
            conversationId: child.id,
            at: deps.now(),
          };
          return { status: "running", checkpoint: { phase: "run" } };
        }, context);
      },
      run: async (task, runtime, context) => {
        const n = task.input.number;
        const row = (await runtime.snapshot(JobBoardDoc, context))?.jobs[String(n)];
        const id = row?.review?.conversationId ?? null;
        if (row === undefined || row.result === null || id === null) {
          await runtime.commit(() => terminal, context);
          return;
        }
        const conversation = await runtime.conversation(id, context);
        if (conversation === undefined) throw new Error(`review of job ${n}: no conversation`);
        const submission = await conversation.submit(
          {
            type: "input",
            content: reviewInput(row, row.result.text),
            whenBusy: "followUp",
            requestId: `review:${n}:${String(id)}`,
          },
          context,
        );
        const settled = await submission.wait(context);
        let decided: { verdict: "pass" | "reject"; model: string } | undefined;
        await runtime.commit(async (tx) => {
          const current = (await tx.doc(JobBoardDoc)).jobs[String(n)];
          if (current === undefined || current.review === null) return terminal;
          let said = "";
          if (settled.status !== "unanswered" && settled.type === "input") {
            said = textOf(
              (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                | AssistantMessage
                | undefined,
            );
          }
          const verdict = readReviewVerdict(said);
          current.review.status = verdict.verdict === "pass" ? "passed" : "rejected";
          current.review.reason = verdict.reason;
          current.review.at = deps.now();
          if (verdict.verdict === "reject") current.status = "rejected";
          await recordCost(tx, n, await jobCost(tx, current));
          decided = { verdict: verdict.verdict, model: current.review.model };
          if (deps.relay === true) return terminal;
          return {
            status: "running",
            checkpoint: { phase: "notify", passed: verdict.verdict === "pass" },
          };
        }, context);
        if (decided !== undefined) {
          logEvent(decided.verdict === "pass" ? "job.review_passed" : "job.review_rejected", {
            cell: person,
            job: n,
            reviewer_model: decided.model,
          });
        }
      },
      notify: async (task, runtime, context) => {
        const n = task.input.number;
        const { passed } = task.state.checkpoint;
        const lead = await runtime.conversation(runtime.conversationId, context);
        await lead?.submit(
          {
            type: "input",
            content: passed
              ? `[job ${n} risky: pull it with job_result]`
              : `[job ${n} failure: review rejected]`,
            whenBusy: "followUp",
            requestId: `wake:${n}:review:${String(task.id)}`,
          },
          context,
        );
        await runtime.commit(async (tx) => {
          const result = (await tx.doc(JobBoardDoc)).jobs[String(n)]?.result;
          if (result !== undefined && result !== null) result.wokeAt ??= deps.now();
          return terminal;
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

export type ReviewTask = ReturnType<typeof createReviewTask>;

/** For `job_result`: what the lead may see of a risky result, or null when it may pull it. */
export function reviewHold(row: Pick<JobRow, "number" | "result" | "review">): string | null {
  if (row.result === null || row.result.kind !== "risky") return null;
  if (row.review === null || row.review.status === "running") {
    return `job ${row.number}'s result is under review; you get a notice when it is done.`;
  }
  if (row.review.status === "rejected") {
    return `job ${row.number} review rejected: ${row.review.reason}. Choose set_job or restart_job.`;
  }
  return null;
}
