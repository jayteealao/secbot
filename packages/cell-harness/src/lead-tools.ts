/**
 * The lead's job tools. Every one returns in its own round: starting, reading, pulling, and
 * steering a job is one local commit or read, so its answer is its receipt; the job's work runs
 * in its job task (job-task.ts) and its result waits on the board until the lead pulls it.
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  type Harness,
  LiveDoc,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { BudgetWaiter } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import {
  JobBoardDoc,
  type JobRow,
  RoleModelsDoc,
  StopDoc,
  TemplatesDoc,
  TierSettingsDoc,
} from "./docs.ts";
import type { SharedOp } from "./household-contract.ts";
import {
  answerQuestion,
  blockReason,
  createJobRow,
  ENDED,
  escalate,
  escalationsUsed,
  exhaust,
  jobCost,
  markRisky,
  openQuestion,
  pullResult,
  restartRow,
  resumeRow,
  setTierEffort,
} from "./job-board.ts";
import type { JobHolds } from "./job-holds.ts";
import { configureJob, createJobTask, type JobTask, type JobTaskDeps } from "./job-task.ts";
import {
  ANSWER_MAX_CHARS,
  askPersonText,
  exhaustedText,
  ISO_DATE,
  JOB_WAITS_NOTE,
  jobParameter,
  literals,
  refusal,
  resumeRefusalText,
  rowOrError,
  SHARED_KEEPS_TIER,
  SHARED_NO_MARK,
  SHARED_NO_QUESTIONS,
  sharedNotStartedText,
  sharedPayerText,
  sharedRestartOwnerText,
  sharedRestartUsedText,
  sharedResultBody,
  text,
} from "./lead-texts.ts";
import { budgetOf } from "./month-ledger.ts";
import {
  createReadResultTool,
  createReceiptTask,
  type ReceiptTask,
  type RemoteDeps,
  remoteWraps,
} from "./receipts.ts";
import { DEFAULT_JOB_EFFORT, JOB_EFFORTS, TIERS } from "./release-defaults.ts";
import { createReviewTask, type ReviewTask, reviewHold, startReview } from "./result-review.ts";
import { logResumed, resumeInCommit } from "./resume-job.ts";
import { createSharedLeadTools } from "./shared-lead-tools.ts";
import { sharedOpId } from "./shared-relay.ts";
import { STOP_RUNNING } from "./stop.ts";
import { appliedEffort, capOf, templateNamed, templatesOf, tierModelOf } from "./templates.ts";

export interface JobsExtensionDeps {
  /** After a job starts or ends (the capacity watch); see JobTaskDeps.onJobsChanged. */
  readonly onJobsChanged?: JobTaskDeps["onJobsChanged"];
  readonly person: string;
  readonly gate: () => BudgetWaiter | undefined;
  readonly timeZone: string;
  readonly models: () => Models;
  /** The extensions a job conversation selects (no tool that starts work). */
  readonly jobExtensions: () => readonly Extension[];
  readonly now: () => number;
  /** The household and secrets cells the lead's remote tools reach in the background. */
  readonly remote?: RemoteDeps;
  /** Where paused and questioning jobs wait; a lead move wakes the job. */
  readonly holds: JobHolds;
  /** The harness, to abort a job's task when the lead restarts it or it used its escalations. */
  readonly harness: () => Harness;
  /** The extensions of a result reviewer's conversation: no tools. */
  readonly reviewExtensions: () => readonly Extension[];
  /**
   * Shared household jobs: the other person of the household and the background exchange to
   * start after a shared action; undefined in a cell with no household.
   */
  readonly shared?: () => { readonly other: string; kick(): void } | undefined;
}

/** The lead run's first input while the lead is busy (the run's turn), else null. */
export async function turnOf(
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: Context,
): Promise<number | null> {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  const first = live?.run?.inputs[0];
  return first === undefined ? null : Number(first);
}

/** One line about a job for the lead. */
export function jobSummary(row: JobRow): string {
  const effort =
    row.effort.applied === row.effort.requested
      ? `effort ${row.effort.applied}`
      : `effort ${row.effort.applied} (asked ${row.effort.requested})`;
  const due = row.deadline === null ? "" : ` due ${row.deadline}`;
  const result =
    row.result === null
      ? "no result yet"
      : row.result.pulledAt === null
        ? `a ${row.result.kind} result waits: pull it with job_result`
        : `its ${row.result.kind} result was pulled`;
  const open = openQuestion(row);
  const question =
    open === null
      ? ""
      : ` Its question waits: "${open.text}"${open.toPerson ? " (asked the person)" : ""}; answer with answer_job.`;
  const blocked =
    row.status === "blocked" && row.block !== null ? ` blocked: ${blockReason(row.block)}.` : "";
  const shared =
    row.shared === null
      ? ""
      : ` Shared with ${row.shared.with} (${sharedPayerText(row.shared)}), proposed by ${row.shared.role === "requester" ? "you" : "them"}, consent ${row.shared.consent}.`;
  return `job ${row.number} "${row.title}": ${row.status}, ${row.template} on ${row.tier}, ${effort}, $${row.cost.toFixed(2)} of $${row.cap}, priority ${row.priority}${due}, ${row.attempts.raises} raises and ${row.attempts.restarts} restarts; ${result}.${question}${blocked}${shared}`;
}

/** The most a job transcript gives the lead, in characters. */
export const TRANSCRIPT_MAX_CHARS = 4_000;

const partsText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (content as readonly { type: string; text?: string; name?: string; arguments?: unknown }[])
        .flatMap((part) =>
          part.type === "text" && part.text !== undefined
            ? [part.text]
            : part.type === "toolCall"
              ? [`[calls ${part.name} ${JSON.stringify(part.arguments)}]`]
              : [],
        )
        .join(" ");

/**
 * A transcript as role-labelled lines, oldest first, tool errors marked: the newest lines that fit
 * `max` characters.
 */
export function transcriptText(entries: readonly EntryRecord[], max: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const message = entry.model?.[0] as
      | { role: string; content: unknown; toolName?: string; isError?: boolean }
      | undefined;
    if (message === undefined || message.role === "system") continue;
    const said = partsText(message.content).replace(/\s+/g, " ").trim();
    if (message.role === "toolResult") {
      lines.push(
        `tool ${message.toolName ?? "?"}${message.isError === true ? " error" : ""}: ${said}`,
      );
    } else {
      lines.push(`${message.role === "assistant" ? "job" : message.role}: ${said}`);
    }
  }
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (size + line.length + 1 > max) {
      if (kept.length === 0) kept.push(line.slice(0, max));
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.reverse().join("\n");
}

export function createJobsExtension(deps: JobsExtensionDeps): {
  readonly extension: Extension;
  readonly JobTask: JobTask;
  readonly ReceiptTask: ReceiptTask;
  readonly ReviewTask: ReviewTask;
} {
  const { person } = deps;
  const ReviewTask = createReviewTask({
    person,
    now: deps.now,
    extensions: deps.reviewExtensions,
  });
  const JobTask = createJobTask({
    person,
    review: () => ReviewTask,
    gate: deps.gate,
    timeZone: deps.timeZone,
    extensions: deps.jobExtensions,
    ...(deps.onJobsChanged === undefined ? {} : { onJobsChanged: deps.onJobsChanged }),
  });
  /**
   * A lead move on a shared row becomes one operation in the row's outbox for the household, which
   * runs the job; the background exchange delivers it. Null when job `n` is not shared.
   */
  const sharedMove = async (
    api: Pick<ToolExecutionApi, "commit">,
    context: Context,
    n: number,
    decide: (
      row: JobRow,
      link: NonNullable<JobRow["shared"]>,
    ) => { readonly op: SharedOp } | { readonly error: string },
  ): Promise<{ readonly attempts: number } | { readonly error: string } | null> => {
    const moved = await api.commit(async (tx) => {
      const board = await tx.doc(JobBoardDoc);
      const row = Object.hasOwn(board.jobs, String(n)) ? board.jobs[String(n)] : undefined;
      if (row === undefined || row.shared === null) return null;
      if ((await tx.doc(StopDoc)).active !== null) return { error: STOP_RUNNING };
      const decided = decide(row, row.shared);
      if ("error" in decided) return decided;
      row.shared.outbox.push(decided.op);
      return { attempts: row.attempts.raises + row.attempts.restarts };
    }, context);
    if (moved !== null && !("error" in moved)) deps.shared?.()?.kick();
    return moved;
  };

  /**
   * A job past its escalations ended failed in the caller's commit: its task stops (a paused run
   * waits on its hold, which the abort rejects); the lead asks the person in its own words.
   */
  const endExhausted = async (
    ended: {
      readonly number: number;
      readonly taskId: TaskId | null;
      readonly cost: number;
      readonly cap: number;
    },
    context: Context,
  ) => {
    logEvent("job.paused", {
      cell: person,
      job: ended.number,
      reason: "escalation",
      cost_usd: ended.cost,
      cap_usd: ended.cap,
    });
    if (ended.taskId !== null) {
      await deps.harness().abortTask(ended.taskId, withoutAbortSignal(context));
    }
    deps.holds.wake(ended.number);
  };

  const startJob = defineTool({
    name: "start_job",
    description:
      "Start a job: a fresh subagent works on it in the background from a template. Use it for research, anything with several steps, or an outside action. Write a self-contained brief in your own words. Returns at once with the job's number; the result waits on your job board until you pull it with job_result.",
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 80,
          description: "A few words on what the job does, as you tell the person.",
        }),
      ),
      brief: Type.Optional(
        Type.String({ minLength: 1, description: "The brief, written by you." }),
      ),
      template: Type.Optional(
        Type.String({ description: "The template's name, from your job board." }),
      ),
      request: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "A job another job asked for: start that row (title, brief, and template come from it).",
        }),
      ),
      priority: Type.Optional(
        literals(["urgent", "deadline", "routine", "research"] as const, "Default routine."),
      ),
      deadline: Type.Optional(
        Type.String({ description: "The date the person needs it by, as YYYY-MM-DD." }),
      ),
      tier: Type.Optional(literals(TIERS, "Default: the template's tier. Lower is cheaper.")),
      effort: Type.Optional(literals(JOB_EFFORTS, `Default ${DEFAULT_JOB_EFFORT}.`)),
    }),
    // A crash mid-call gives the model an interrupted result instead of starting a second job.
    replay: "unsafe",
    execute: async (args, api, context) => {
      if (args.deadline !== undefined && !ISO_DATE.test(args.deadline)) {
        return refusal(`The deadline "${args.deadline}" is not a date like 2026-11-30.`);
      }
      const turn = await turnOf(api, context);
      if (
        args.request === undefined &&
        (args.title === undefined || args.brief === undefined || args.template === undefined)
      ) {
        return refusal("A new job needs a title, a brief, and a template.");
      }
      const started = await api.commit(async (tx) => {
        // No job starts while a stop runs.
        if ((await tx.doc(StopDoc)).active !== null) return { error: STOP_RUNNING };
        if (args.request !== undefined) {
          const found = await rowOrError(tx, args.request);
          if ("error" in found) return found;
          if (found.requestedBy === null || found.status !== "queued" || found.taskId !== null) {
            return { error: `job ${args.request} is not a requested job waiting to start.` };
          }
          const tier = args.tier ?? found.tier;
          const requested = args.effort ?? found.effort.requested;
          const modelId = tierModelOf(tier, (await tx.doc(RoleModelsDoc)).overrides);
          const row = await setTierEffort(tx, found.number, {
            tier,
            requested,
            applied: appliedEffort(deps.models(), modelId, requested),
          });
          // The task id is on the row from this commit, so a stop that lands before the task
          // opens finds the job and aborts it.
          const taskId = await tx.createTask(
            JobTask,
            { number: row.number, attempt: 0 },
            { ownership: { kind: "conversation" }, background: true },
          );
          const placed = (await tx.doc(JobBoardDoc)).jobs[String(row.number)];
          if (placed !== undefined) placed.taskId = taskId as TaskId;
          return { ...row, effort: { ...row.effort } };
        }
        const template = templateNamed(
          templatesOf((await tx.doc(TemplatesDoc)).custom),
          args.template ?? "",
        );
        if ("error" in template) return template;
        const tier = args.tier ?? template.tier;
        const requested = args.effort ?? DEFAULT_JOB_EFFORT;
        const modelId = tierModelOf(tier, (await tx.doc(RoleModelsDoc)).overrides);
        const row = await createJobRow(tx, {
          title: (args.title ?? "").trim(),
          brief: args.brief ?? "",
          priority: args.priority ?? "routine",
          deadline: args.deadline ?? null,
          template: template.name,
          tier,
          effort: { requested, applied: appliedEffort(deps.models(), modelId, requested) },
          owner: person,
          turn,
          createdAt: deps.now(),
        });
        const taskId = await tx.createTask(
          JobTask,
          { number: row.number, attempt: 0 },
          { ownership: { kind: "conversation" }, background: true },
        );
        const placed = (await tx.doc(JobBoardDoc)).jobs[String(row.number)];
        if (placed !== undefined) placed.taskId = taskId as TaskId;
        return { ...row, effort: { ...row.effort } };
      }, context);
      if ("error" in started) return refusal(started.error);
      const waits = (await deps.gate()?.isOver(budgetOf(started.template), context)) === true;
      const notice = `On it: ${started.title} (job ${started.number}, ${started.template}, ${started.tier})`;
      return {
        ...text(
          `job ${started.number} started: ${started.template}, ${started.tier}, effort ${started.effort.applied}.${waits ? JOB_WAITS_NOTE : ""} Tell the person in one line: ${notice}`,
        ),
        details: { job: started.number, template: started.template, tier: started.tier },
      };
    },
  });

  const readJob = defineTool({
    name: "read_job",
    description: "Read one job's row on your job board: status, tier, effort, cost, and result.",
    parameters: Type.Object({ job: jobParameter }),
    replay: "safe",
    execute: async (args, api, context) => {
      const found = await api.commit(async (tx) => {
        const row = await rowOrError(tx, args.job);
        if ("error" in row) return row;
        // A running job's cost is read from its ledgers, not the last settled figure.
        const cost = ENDED.has(row.status) ? row.cost : Math.max(row.cost, await jobCost(tx, row));
        return { summary: jobSummary({ ...row, cost }) };
      }, context);
      if ("error" in found) return refusal(found.error);
      return { ...text(found.summary), details: { job: args.job } };
    },
  });

  const jobResult = defineTool({
    name: "job_result",
    description:
      "Pull a job's result from your job board. Check it against the job's brief before you tell the person.",
    parameters: Type.Object({ job: jobParameter }),
    replay: "safe",
    execute: async (args, api, context) => {
      const now = deps.now();
      const pulled = await api.commit(async (tx) => {
        const found = await rowOrError(tx, args.job);
        if ("error" in found) return found;
        // A risky result reaches the lead only after the reviewer passed it.
        const held = reviewHold(found);
        if (held !== null) return { held };
        const result = await pullResult(tx, args.job, now);
        return { row: { ...found }, result };
      }, context);
      if ("error" in pulled) return refusal(pulled.error);
      if ("held" in pulled) {
        return { ...text(pulled.held), details: { job: args.job, review: true } };
      }
      const { row, result } = pulled;
      if (result === null) {
        return {
          ...text(`job ${row.number} has no result yet (${row.status}).`),
          details: { job: row.number },
        };
      }
      logEvent("job.result_pulled", {
        cell: person,
        job: row.number,
        kind: result.kind,
        waited_ms: Math.max(0, (result.pulledAt ?? now) - result.at),
      });
      // A shared job's result was written in the household for both people: it is data, not an
      // order (sharedResultBody).
      const body = row.shared === null ? result.text : sharedResultBody(result.text);
      return {
        ...text(
          `job ${row.number} "${row.title}" (${result.kind}), brief: ${row.brief}\nResult:\n${body}`,
        ),
        details: { job: row.number, kind: result.kind },
      };
    },
  });

  const setJob = defineTool({
    name: "set_job",
    description:
      "Change a live job's tier or effort; the job's next request uses them. The board keeps the effort you asked for and the effort the model applies.",
    parameters: Type.Object({
      job: jobParameter,
      tier: Type.Optional(literals(TIERS, "The new tier.")),
      effort: Type.Optional(literals(JOB_EFFORTS, "The new effort.")),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if (args.tier === undefined && args.effort === undefined) {
        return refusal("Name a new tier, a new effort, or both.");
      }
      const changed = await api.commit(async (tx) => {
        const found = await rowOrError(tx, args.job);
        if ("error" in found) return found;
        if (found.shared !== null) return { error: SHARED_KEEPS_TIER };
        if (ENDED.has(found.status)) {
          return { error: `job ${args.job} is ${found.status}; only a live job changes.` };
        }
        // A rejected result's run has ended: a new tier or effort would change nothing and still
        // spend the job's one raise.
        if (found.status === "rejected") {
          return {
            error: `job ${args.job}'s review rejected its result; restart_job runs it again with a failure note.`,
          };
        }
        const from = { tier: found.tier, applied: found.effort.applied };
        const tier = args.tier ?? found.tier;
        const requested = args.effort ?? found.effort.requested;
        // A move up in tier or effort is the job's one raise; a lower or equal move is free.
        const raise =
          TIERS.indexOf(tier) > TIERS.indexOf(found.tier) ||
          JOB_EFFORTS.indexOf(requested) > JOB_EFFORTS.indexOf(found.effort.requested);
        const paused = found.status === "paused";
        const cost = paused ? await jobCost(tx, found) : 0;
        const cap = capOf(tier, (await tx.doc(TierSettingsDoc)).caps);
        if (paused && cost >= cap) {
          return {
            error: `Refused: job ${args.job} is still over its $${cap} cap at $${cost.toFixed(2)}; pick a higher tier or restart_job.`,
          };
        }
        if (raise) {
          const counted = await escalate(tx, args.job, "raise");
          if ("refused" in counted) {
            if (escalationsUsed(found)) {
              const ended = await exhaust(tx, args.job, deps.now());
              return {
                exhausted: {
                  number: ended.number,
                  taskId: ended.taskId,
                  cost: ended.cost,
                  cap: ended.cap,
                },
              };
            }
            return { error: `Refused: job ${args.job} has used its raise; restart_job is left.` };
          }
        }
        const modelId = tierModelOf(tier, (await tx.doc(RoleModelsDoc)).overrides);
        const row = await setTierEffort(tx, args.job, {
          tier,
          requested,
          applied: appliedEffort(deps.models(), modelId, requested),
        });
        await configureJob(tx, row, deps.jobExtensions());
        const resumed = paused && (await resumeRow(tx, args.job, deps.now()));
        return {
          from,
          raise,
          resumed,
          row: { ...row, effort: { ...row.effort }, attempts: { ...row.attempts } },
        };
      }, context);
      if ("exhausted" in changed) {
        await endExhausted(changed.exhausted, context);
        return refusal(exhaustedText(args.job));
      }
      if ("error" in changed) return refusal(changed.error);
      const { from, row } = changed;
      if (changed.resumed) deps.holds.wake(row.number);
      if (changed.raise) {
        logEvent("job.raised", {
          cell: person,
          job: row.number,
          attempts: row.attempts.raises + row.attempts.restarts,
        });
      }
      logEvent("job.effort_changed", {
        cell: person,
        job: row.number,
        from_tier: from.tier,
        to_tier: row.tier,
        effort_requested: row.effort.requested,
        effort_applied: row.effort.applied,
      });
      return {
        ...text(
          `job ${row.number} now runs on ${row.tier} (cap $${row.cap}), effort ${row.effort.applied}${row.effort.applied === row.effort.requested ? "" : ` (asked ${row.effort.requested}; the model does not offer it)`}.${changed.resumed ? " It was paused and runs again." : ""}`,
        ),
        details: { job: row.number, tier: row.tier, effort: row.effort.applied },
      };
    },
  });

  const jobTranscript = defineTool({
    name: "job_transcript",
    description:
      "Read the newest steps of a job's current conversation (or its last run's), tool errors included, before you write a failure note for restart_job.",
    parameters: Type.Object({
      job: jobParameter,
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "How many entries, default 20." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const found = await api.commit(async (tx) => {
        const row = await rowOrError(tx, args.job);
        if ("error" in row) return row;
        return { conversationId: row.conversationId ?? row.runs.at(-1)?.conversationId ?? null };
      }, context);
      if ("error" in found) return refusal(found.error);
      if (found.conversationId === null) {
        return { ...text(`job ${args.job} has no transcript yet.`), details: { job: args.job } };
      }
      const conversation = await deps.harness().conversation(found.conversationId, context);
      const page = await conversation?.entries({}, args.limit ?? 20, undefined, context);
      const said = transcriptText([...(page?.items ?? [])].reverse(), TRANSCRIPT_MAX_CHARS);
      return {
        ...text(said === "" ? `job ${args.job}'s transcript is empty.` : said),
        details: { job: args.job },
      };
    },
  });

  const { proposeSharedJob, offerShared } = createSharedLeadTools(deps);

  const restartJob = defineTool({
    name: "restart_job",
    description:
      "Restart a job with a fresh subagent, once per job: write a failure note (what was tried, why it failed, partial results) from its transcript. The new subagent gets the note and the brief and can search the old transcript. Keeps the job's number, board row, and cost.",
    parameters: Type.Object({
      job: jobParameter,
      note: Type.String({ minLength: 1, maxLength: 2_000, description: "The failure note." }),
    }),
    // A crash mid-call gives the model an interrupted result instead of a second restart.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const at = deps.now();
      const shared = await sharedMove(api, context, args.job, (row, link) => {
        if (link.role !== "requester") return { error: sharedRestartOwnerText(link.with) };
        if (link.household === null) return { error: sharedNotStartedText(row.number, link.with) };
        if (row.attempts.restarts > 0) return { error: sharedRestartUsedText(row.number) };
        return {
          op: {
            kind: "restart",
            opId: sharedOpId(person, at),
            person,
            household: link.household,
            note: args.note,
          },
        };
      });
      if (shared !== null) {
        if ("error" in shared) return refusal(shared.error);
        logEvent("job.restarted", {
          cell: person,
          job: args.job,
          attempts: shared.attempts + 1,
          note_chars: args.note.length,
        });
        return {
          ...text(
            `job ${args.job} restarts in the household with a fresh subagent and your note; this was its one restart.`,
          ),
          details: { job: args.job },
        };
      }
      const changed = await api.commit(async (tx) => {
        const answer = await restartRow(tx, JobTask, args.job, args.note, at);
        if ("missing" in answer) return (await rowOrError(tx, args.job)) as { error: string };
        return answer;
      }, context);
      if ("exhausted" in changed) {
        await endExhausted(changed.exhausted, context);
        return refusal(exhaustedText(args.job));
      }
      if ("error" in changed) return refusal(changed.error);
      if (changed.oldTaskId !== null) {
        await deps.harness().abortTask(changed.oldTaskId, withoutAbortSignal(context));
      }
      deps.holds.wake(changed.ok.number);
      logEvent("job.restarted", {
        cell: person,
        job: changed.ok.number,
        attempts: changed.ok.raises + changed.ok.restarts,
        note_chars: args.note.length,
      });
      return {
        ...text(
          `job ${changed.ok.number} restarts with a fresh subagent and your note; this was its one restart.`,
        ),
        details: { job: changed.ok.number },
      };
    },
  });

  const resumeJob = defineTool({
    name: "resume_job",
    description:
      "Resume a job the person stopped, or one the content check blocked, from its kept brief and transcript. Only when the person asks. It does not use the job's restart.",
    parameters: Type.Object({ job: jobParameter }),
    // A crash mid-call gives the model an interrupted result instead of a second resume.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const resumed = await api.commit(
        (tx) => resumeInCommit(tx, { task: JobTask, person, at: deps.now(), by: "lead" }, args.job),
        context,
      );
      if (!resumed.ok) {
        return refusal(
          resumed.waitingOn !== null
            ? sharedNotStartedText(args.job, resumed.waitingOn)
            : resumeRefusalText(args.job, resumed.reason, resumed.status),
        );
      }
      if (resumed.shared) deps.shared?.()?.kick();
      logResumed(person, resumed, "lead");
      return {
        ...text(
          resumed.shared
            ? `job ${resumed.job} resumes in the household from its kept brief and transcript; this does not use its restart.`
            : `job ${resumed.job} resumes from its kept brief and transcript; this does not use its restart.`,
        ),
        details: { job: resumed.job },
      };
    },
  });

  const markRiskyTool = defineTool({
    name: "mark_risky",
    description:
      "Mark a job's result risky so a reviewer on another model checks it before you use it. A mark cannot be removed, by you or anyone.",
    parameters: Type.Object({
      job: jobParameter,
      reason: Type.String({ minLength: 1, maxLength: 200, description: "Why it needs a check." }),
      risky: Type.Optional(Type.Boolean({ description: "Must be true; a mark is never removed." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if (args.risky === false) {
        const found = await api.commit(async (tx) => {
          const row = await rowOrError(tx, args.job);
          if ("error" in row) return row;
          if (row.shared !== null) return { error: SHARED_NO_MARK };
          return { code: row.risky.code.length, lead: row.risky.lead };
        }, context);
        if ("error" in found) return refusal(found.error);
        const by = found.code > 0 ? "code" : found.lead !== null ? "you" : undefined;
        return refusal(
          by === undefined
            ? `job ${args.job} is not marked risky; a mark can only be added.`
            : `job ${args.job} is marked risky by ${by}; a mark cannot be removed.`,
        );
      }
      const marked = await api.commit(async (tx) => {
        const found = await rowOrError(tx, args.job);
        if ("error" in found) return found;
        if (found.shared !== null) return { error: SHARED_NO_MARK };
        const row = await markRisky(tx, args.job, { lead: args.reason });
        // An unpulled routine result is reviewed before the lead uses it.
        const result = row.result;
        const review = result !== null && result.pulledAt === null && result.kind === "routine";
        if (review) {
          result.kind = "risky";
          await startReview(tx, ReviewTask, args.job);
        }
        return { number: row.number, review };
      }, context);
      if ("error" in marked) return refusal(marked.error);
      logEvent("job.risky_marked", {
        cell: person,
        job: marked.number,
        by: "lead",
        reasons: 1,
      });
      return {
        ...text(
          marked.review
            ? `job ${marked.number} is marked risky; its result is checked by a reviewer before you get it.`
            : `job ${marked.number} is marked risky.`,
        ),
        details: { job: marked.number },
      };
    },
  });

  const answerJob = defineTool({
    name: "answer_job",
    description:
      "Answer a job's open question (read it with read_job). Answer from your history and the brief; the job goes on with your answer.",
    parameters: Type.Object({
      job: jobParameter,
      answer: Type.String({
        minLength: 1,
        maxLength: ANSWER_MAX_CHARS,
        description: "The answer.",
      }),
    }),
    // A second run finds the question answered and refuses; the first answer stands.
    replay: "safe",
    execute: async (args, api, context) => {
      const answered = await api.commit(async (tx) => {
        const found = await rowOrError(tx, args.job);
        if ("error" in found) return found;
        if (found.shared !== null) return { error: SHARED_NO_QUESTIONS };
        const open = openQuestion(found);
        if (open === null) return { error: `job ${args.job} has no question waiting.` };
        if (open.from !== "job") {
          return { error: `job ${args.job}'s question is for the person; they answer it.` };
        }
        const question = await answerQuestion(tx, args.job, args.answer, "lead", deps.now());
        return { number: found.number, question: question?.number ?? 0 };
      }, context);
      if ("error" in answered) return refusal(answered.error);
      deps.holds.wake(answered.number);
      logEvent("job.answered", {
        cell: person,
        job: answered.number,
        by: "lead",
        answer_chars: args.answer.length,
      });
      return {
        ...text(`job ${answered.number} has your answer and goes on.`),
        details: { job: answered.number, question: answered.question },
      };
    },
  });

  const askPerson = defineTool({
    name: "ask_person",
    description:
      "Hand a job's open question to the person, when you lack the answer or the answer commits them. Then ask them in your own words in the same reply.",
    parameters: Type.Object({ job: jobParameter }),
    replay: "safe",
    execute: async (args, api, context) => {
      const asked = await api.commit(async (tx) => {
        const found = await rowOrError(tx, args.job);
        if ("error" in found) return found;
        if (found.shared !== null) return { error: SHARED_NO_QUESTIONS };
        const open = openQuestion(found);
        if (open === null) return { error: `job ${args.job} has no question waiting.` };
        const fresh = !open.toPerson;
        open.toPerson = true;
        open.personAskedAt ??= deps.now();
        return { number: found.number, fresh };
      }, context);
      if ("error" in asked) return refusal(asked.error);
      if (asked.fresh) {
        logEvent("job.question_asked", { cell: person, job: asked.number, to_person: true });
      }
      return { ...text(askPersonText(asked.number)), details: { job: asked.number } };
    },
  });

  const ReceiptTask = createReceiptTask(deps.remote ?? { person, household: () => undefined });
  return {
    JobTask,
    ReceiptTask,
    ReviewTask,
    extension: defineExtension({
      name: "secbot-jobs",
      tools: [
        startJob,
        readJob,
        jobResult,
        setJob,
        restartJob,
        resumeJob,
        jobTranscript,
        markRiskyTool,
        answerJob,
        askPerson,
        proposeSharedJob,
        offerShared,
        createReadResultTool(deps.now),
      ],
      wraps: remoteWraps(person, ReceiptTask, turnOf, deps.now),
      tasks: [JobTask, ReceiptTask, ReviewTask],
    }),
  };
}
