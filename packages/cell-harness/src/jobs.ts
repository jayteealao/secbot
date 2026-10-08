/**
 * Jobs in the activity view: hand-offs (the reporter task, handoff.ts) and routine runs (each
 * reminder included, routines.ts). A job that ends writes one stored activity record of kind `job`
 * in the commit that ends it, so it is kept with no pruning like every other record. A job that is
 * running or waiting is read live from the harness's task list at request time: pi-durable lists
 * only live work (installed pi-durable 1.0.3, dist/harness/types.d.ts:430-433 `HarnessInspection`,
 * :508 `inspect()`), so the two never overlap.
 *
 * A hand-off job's cost is the specialist conversation's ledger growth since the later of the
 * job's start and that specialist's last finished job (`JobsDoc.high`). Specialists work only on
 * hand-offs, so the costs of one specialist's jobs add up to its spend, overlapping jobs included.
 * A routine run costs nothing itself: it sends a message to the lead, whose answer is chat spend.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  type ConversationId,
  type Harness,
  type JsonObject,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type { ActivityRecord } from "./activity.ts";
import { shortText } from "./budget-gate.ts";
import { type BudgetName, BudgetWaitsDoc, JobsDoc } from "./docs.ts";
import { conversationTotal } from "./month-ledger.ts";
import { redactText } from "./redact.ts";
import { ROUTINE_KIND_PREFIX } from "./wake-times.ts";

/** The hand-off reporter task's kind (handoff.ts). */
export const REPORTER_KIND = "secbot.handoff-reporter";
/** The width of the activity list's TOOL OR JOB column, less one space. */
export const LABEL_WIDTH = 24;

/**
 * A job's label from its waiting-list text, with a colon after the first word: `handoff research
 * train times` -> `job: train times`, `reminder bins out` -> `reminder: bins out`, `routine
 * morning check` -> `routine: morning check`; at most LABEL_WIDTH characters.
 */
export function jobLabel(what: string): string {
  const [first = "", ...rest] = what.trim().split(/\s+/);
  const handoff = first === "handoff";
  const words = handoff ? rest.slice(1) : rest;
  const head = handoff ? "job" : first;
  const label = words.length === 0 ? head : `${head}: ${words.join(" ")}`;
  if (label.length <= LABEL_WIDTH) return label;
  // Cut at the last whole word that fits; a single long word is cut at the width.
  const cut = label.slice(0, LABEL_WIDTH + 1);
  const space = cut.lastIndexOf(" ");
  return (space > head.length + 1 ? cut.slice(0, space) : cut.slice(0, LABEL_WIDTH)).trimEnd();
}

/** The waiting-list text of a hand-off: `handoff <specialist> <first words of the brief>`. */
export const handoffWhat = (specialist: string, brief: string) =>
  `handoff ${specialist} ${shortText(brief)}`;

/** A finished job's stored record. */
export function doneRecord(fields: {
  readonly key: string;
  readonly at: number;
  readonly agent: string;
  readonly label: string;
  readonly reason: string;
  readonly cost: number;
}): ActivityRecord {
  return {
    key: fields.key,
    at: fields.at,
    kind: "job",
    agent: fields.agent,
    tool: fields.label,
    verdict: "done",
    layer: "job",
    reason: redactText(fields.reason),
    ruleId: null,
    ruleLevel: null,
    arguments: {},
    cost: fields.cost,
  };
}

/** Marks a hand-off job's start: the specialist's ledger total now, unless a rerun set it. */
export async function markJobStart(
  tx: Tx,
  taskId: string,
  conversationId: ConversationId,
): Promise<void> {
  const jobs = await tx.doc(JobsDoc);
  if (Object.hasOwn(jobs.starts, taskId)) return;
  jobs.starts[taskId] = conversationTotal(await tx.doc(UsageDoc, conversationId));
}

/** The cost of a job so far: the growth past the later of its start and the specialist's mark. */
function costSince(total: number, start: number | undefined, high: number | undefined): number {
  return Math.max(0, total - Math.max(start ?? total, high ?? 0));
}

/**
 * Takes a finished hand-off job's cost and moves the specialist's mark to its total now. A rerun
 * that finds the cost taken returns it unchanged. A job stopped before it started costs nothing
 * and leaves the mark alone: the specialist's spend since the mark belongs to its running jobs.
 */
export async function takeJobCost(
  tx: Tx,
  taskId: string,
  role: string,
  conversationId: ConversationId,
): Promise<number> {
  const jobs = await tx.doc(JobsDoc);
  const taken = Object.hasOwn(jobs.ends, taskId) ? jobs.ends[taskId] : undefined;
  if (taken !== undefined) return taken;
  if (!Object.hasOwn(jobs.starts, taskId)) {
    jobs.ends[taskId] = 0;
    return 0;
  }
  const total = conversationTotal(await tx.doc(UsageDoc, conversationId));
  const high = Object.hasOwn(jobs.high, role) ? jobs.high[role] : undefined;
  const cost = costSince(total, jobs.starts[taskId], high);
  jobs.ends[taskId] = cost;
  jobs.high[role] = Math.max(total, high ?? 0);
  return cost;
}

/** The cost a done record carries; the job's marks are dropped in the same commit. */
export async function endJob(tx: Tx, taskId: string): Promise<number> {
  const jobs = await tx.doc(JobsDoc);
  const cost = jobs.ends[taskId] ?? 0;
  delete jobs.starts[taskId];
  delete jobs.ends[taskId];
  return cost;
}

/** `HH:MM` in `timeZone`. */
function clockOf(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** `9 Oct 19:00` in `timeZone`. */
function dayOf(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}

const waitText = (wait: { budget: BudgetName; since: number }, timeZone: string) =>
  `waits above ${wait.budget === "developer" ? "the developer budget" : "your limit"} since ${clockOf(wait.since, timeZone)}`;

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  brief: string;
  startedAt: number;
};

/** A routine run's label: its waiting-list text (a reminder's text), else `routine <name>`. */
export function routineWhat(name: string, payload: JsonValue | undefined): string {
  const text = (payload as JsonObject | null | undefined)?.text;
  return name === "reminder" && typeof text === "string"
    ? `reminder ${shortText(text)}`
    : `routine ${name.replace(/-/g, " ")}`;
}

function liveRecord(
  taskId: string,
  fields: Pick<ActivityRecord, "at" | "agent" | "tool" | "reason" | "cost"> & {
    readonly state: "running" | "waiting";
  },
): ActivityRecord {
  return {
    key: `live:${taskId}`,
    at: fields.at,
    kind: "job",
    agent: fields.agent,
    tool: fields.tool,
    verdict: fields.state,
    layer: "job",
    reason: fields.reason,
    ruleId: null,
    ruleLevel: null,
    arguments: {},
    cost: fields.cost,
  };
}

/**
 * The jobs running or waiting now, newest first: each hand-off reporter and each routine task
 * except the `quiet` ones (routines that spend nothing, such as the heartbeat). A task listed in
 * `secbot.budget-waits` is waiting; so is a reporter in its first step whose specialist's
 * generation waits there (`job <specialist>`).
 */
export async function liveJobs(
  harness: Harness,
  options: {
    readonly now: number;
    readonly timeZone: string;
    readonly quiet?: ReadonlySet<string>;
  },
  context: Context,
): Promise<ActivityRecord[]> {
  const { now, timeZone } = options;
  const inspection = await harness.inspect(context);
  const waits = (await harness.snapshot(BudgetWaitsDoc, context))?.tasks ?? {};
  const jobs = await harness.snapshot(JobsDoc, context);
  const rows: ActivityRecord[] = [];
  for (const { record, state } of inspection.tasks) {
    if (state.kind === "blocked" || state.kind === "completing") continue;
    if (record.state.status === "terminal" || record.state.status === "completing") continue;
    const taskId = String(record.id);
    const wait = Object.hasOwn(waits, taskId) ? waits[taskId] : undefined;
    const checkpoint = record.state.checkpoint as Record<string, JsonValue> | null;
    if (record.kind === REPORTER_KIND) {
      const input = record.input as unknown as ReporterInput;
      const deliver = checkpoint?.phase !== "report";
      const generation = deliver
        ? Object.values(waits).find((each) => each.what === `job ${input.name}`)
        : undefined;
      const waiting = wait ?? generation;
      const total = conversationTotal(
        await harness.snapshot(UsageDoc, input.conversationId, context),
      );
      const start = jobs?.starts[taskId];
      rows.push(
        liveRecord(taskId, {
          at: input.startedAt,
          agent: input.name,
          tool: jobLabel(handoffWhat(input.name, input.brief)),
          state: waiting === undefined ? "running" : "waiting",
          reason:
            waiting !== undefined
              ? waitText(waiting, timeZone)
              : deliver
                ? `step 1 of 2: ${input.name} is working`
                : "step 2 of 2: reporting to the lead",
          cost: start === undefined ? 0 : costSince(total, start, jobs?.high[input.name]),
        }),
      );
    } else if (record.kind.startsWith(ROUTINE_KIND_PREFIX)) {
      const name = record.kind.slice(ROUTINE_KIND_PREFIX.length);
      if (options.quiet?.has(name) === true) continue;
      const wakeAt = typeof checkpoint?.wakeAt === "number" ? checkpoint.wakeAt : now;
      const due = wait === undefined && wakeAt > now;
      rows.push(
        liveRecord(taskId, {
          at: wakeAt,
          agent: "lead",
          tool: jobLabel(
            wait?.what ??
              routineWhat(name, (record.input as { payload?: JsonValue } | null)?.payload),
          ),
          state: wait === undefined && !due ? "running" : "waiting",
          reason:
            wait !== undefined
              ? waitText(wait, timeZone)
              : due
                ? `due ${dayOf(wakeAt, timeZone)}`
                : "running now",
          cost: 0,
        }),
      );
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}
