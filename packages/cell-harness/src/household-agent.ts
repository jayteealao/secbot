/**
 * The household agent: the household cell's model-backed harness. It runs the jobs that belong to
 * both people, from the household's own job board, and never talks to a person: it has no lead,
 * its root conversation is never submitted to, and each person's lead pulls a shared job's result
 * through its own cell. Its jobs have two tools only, `household_read` and `household_change`
 * (plus searching their own earlier attempts); any other tool call is refused, nothing waits for a
 * person, and a household change marks the result risky so a reviewer on another model checks it.
 * The heartbeat routine runs as before.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  type Extension,
  Harness,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { type AlertEnv, createAlerts } from "./alerts.ts";
import { defaultSetTimer, type SetTimer } from "./approvals.ts";
import { type BoardView, boardView } from "./board-view.ts";
import { createBudgetExtension } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import { JobBoardDoc, type JobStop } from "./docs.ts";
import { createGatewayModels, type GatewayEnv } from "./gateway.ts";
import { createHeartbeatRoutine, type HeartbeatEnv } from "./heartbeat.ts";
import type { HouseholdClient, SharedSyncAnswer, SharedSyncRequest } from "./household-contract.ts";
import { createHouseholdExtension } from "./household-tools.ts";
import { createJobGate } from "./job-gate.ts";
import { JobHolds } from "./job-holds.ts";
import { createJobTask, type JobTask } from "./job-task.ts";
import { createJobToolsExtension } from "./job-tools.ts";
import { ModelHealthMonitor } from "./model-health.ts";
import { createReportGate } from "./open-harness.ts";
import { createFixtureToolsExtension } from "./outside-tools.ts";
import { HOUSEHOLD_AGENT_RULES, HOUSEHOLD_AGENT_TOOLS } from "./release-defaults.ts";
import { createReviewTask } from "./result-review.ts";
import { ensureRoutines } from "./routines.ts";
import { cellSettings } from "./settings.ts";
import {
  type Budgets,
  createPayerGate,
  effectsDone,
  exchange,
  overOf,
  rowsFor,
  SharedJobsDoc,
} from "./shared-jobs.ts";
import { type StopAnswer, stopJobs } from "./stop.ts";
import { createTelemetryExtension } from "./telemetry.ts";
import { type NextWake, nextWake, type WakeSummary, wakesOf } from "./wake-times.ts";

/** The tools a household job may call; every other call is refused. */
export const HOUSEHOLD_JOB_TOOLS: ReadonlySet<string> = new Set([
  ...HOUSEHOLD_AGENT_TOOLS,
  "search_old_job",
]);

/** The refusal of any other tool in a household job. */
export const HOUSEHOLD_TOOL_REFUSAL =
  "Refused: a household job has only household_read, household_change, and search_old_job.";

export interface HouseholdAgentOptions {
  readonly cell: string;
  /** The cell's pi-durable storage (the household's documents share its database). */
  readonly storage: Parameters<typeof Harness.open>[0];
  readonly env: HeartbeatEnv & GatewayEnv & AlertEnv;
  readonly now: () => number;
  /** Every harness report, after it is logged or counted. */
  readonly onReport: (error: unknown) => void;
  /** A routine's wake time changed: the cell re-arms its alarm. */
  readonly onWakeChange: () => void;
  readonly fetch?: typeof fetch;
  /** Tests: the model gateway (default: the fleet's gateway key). */
  readonly models?: Models;
  /** Every person's newest month, from the household budget board. */
  readonly budgets: Budgets;
  /** The household's own documents, as the person cells' household tools see them. */
  readonly household: HouseholdClient;
  /** The person cells of the household (names). */
  readonly persons: readonly string[];
  readonly setTimer?: SetTimer;
  readonly context?: Context;
  /**
   * The test cell only: adds `fixture_slow_lookup` (reads nothing, acts on nothing) to a household
   * job's tools, so a live run can hold a shared job running while a stop arrives. Production
   * household jobs keep their fixed list.
   */
  readonly fixtureTools?: { readonly slowMs: number };
}

export interface HouseholdAgent {
  readonly harness: Harness;
  readonly task: JobTask;
  /** The stored wake times and the next one. */
  wakes(): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }>;
  /** One shared-job exchange with a person cell: their operations in, their shared jobs out. */
  exchange(request: SharedSyncRequest): Promise<SharedSyncAnswer>;
  /** The household's shared jobs as a board view (every row there is shared). */
  view(): Promise<BoardView>;
  /**
   * Stops unfinished household jobs with their state kept: every one (the owner's stop), or only
   * those of `jobs` (a person's stop of the shared jobs they are part of).
   */
  stop(by: JobStop["by"], jobs?: readonly number[]): Promise<StopAnswer>;
  /** Logs the count of reports not logged yet, then closes the harness. */
  close(): Promise<void>;
}

/** The first moment of the next UTC month: a job held on both payers' limits waits until then. */
const nextMonthUtc = (at: number): number => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

/** Refuses every tool call of a household job outside its fixed list; nothing is held. */
function householdToolCheck(allowed: ReadonlySet<string>): Extension {
  return defineExtension({
    name: "secbot-household-tools-only",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) =>
          allowed.has(call.name) ? undefined : { block: HOUSEHOLD_TOOL_REFUSAL },
      }),
    ],
  });
}

/**
 * The test cell's slow fixture tool alone, for household jobs (no failing lookup there). The tool
 * reads the wait from `fixtureTools` at each call.
 */
function slowFixtureOnly(fixtureTools: { readonly slowMs: number }): Extension {
  const tools = (createFixtureToolsExtension(fixtureTools).tools ?? []).filter(
    (tool) => tool.name === "fixture_slow_lookup",
  );
  return defineExtension({ name: "secbot-household-fixture-tools", tools });
}

export async function openHouseholdAgent(options: HouseholdAgentOptions): Promise<HouseholdAgent> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const { cell, now } = options;
  let opened: Harness | undefined;
  const current = () => {
    if (opened === undefined) throw new Error("the household agent is not open yet");
    return opened;
  };
  const reports = createReportGate(cell, options.onReport);
  const alerts = createAlerts(options.env, cell, options.fetch);
  const monitor = new ModelHealthMonitor({ person: cell, alerts, now, onReport: reports.report });
  const heartbeat = createHeartbeatRoutine(
    options.env,
    { cell, onWakeChange: options.onWakeChange },
    options.fetch,
  );
  const payers = createPayerGate({
    harness: current,
    budgets: options.budgets,
    setTimer: options.setTimer ?? defaultSetTimer,
    onWaitChange: options.onWakeChange,
  });
  const holds = new JobHolds();
  const telemetry = createTelemetryExtension(cell, monitor);
  const budget = createBudgetExtension(() => payers);
  const fixture = options.fixtureTools === undefined ? [] : [slowFixtureOnly(options.fixtureTools)];
  const fixtureNames = fixture.flatMap((extension) => (extension.tools ?? []).map((t) => t.name));
  const jobList: readonly Extension[] = [
    householdToolCheck(new Set([...HOUSEHOLD_JOB_TOOLS, ...fixtureNames])),
    budget,
    createJobGate({ person: cell, harness: current, holds, now, relay: true }),
    createJobToolsExtension({
      person: cell,
      harness: current,
      holds,
      now,
      wrapped: [...HOUSEHOLD_AGENT_TOOLS, ...fixtureNames],
      household: true,
    }),
    createHouseholdExtension(cell, () => options.household),
    telemetry,
    ...fixture,
  ];
  const ReviewTask = createReviewTask({
    person: cell,
    now,
    extensions: () => [budget, telemetry],
    relay: true,
  });
  const task = createJobTask({
    person: cell,
    review: () => ReviewTask,
    gate: () => payers,
    timeZone: "UTC",
    extensions: () => jobList,
    relay: true,
    instruction: HOUSEHOLD_AGENT_RULES,
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "secbot-household-agent",
      tasks: [heartbeat.task, task, ReviewTask],
    }),
  );
  for (const extension of jobList) registry.install(extension);
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models ?? createGatewayModels(options.env),
      registry,
      settings: cellSettings(jobList),
      now,
      onReport: reports.report,
    },
    context,
  );
  opened = harness;
  try {
    await harness.root(context);
    await ensureRoutines(harness, [{ routine: heartbeat }], now(), context);
    harness.resume();
  } catch (error) {
    reports.flush();
    await harness.close(context).catch(() => {});
    throw error;
  }
  const root = await harness.root(context);
  const stop = (by: JobStop["by"], jobs?: readonly number[]) =>
    stopJobs(
      { harness, root, person: cell, now },
      by,
      withoutAbortSignal(context),
      {},
      jobs === undefined ? undefined : (row) => jobs.includes(row.number),
    );
  return {
    harness,
    task,
    stop,
    view: async () =>
      boardView({
        person: cell,
        board: (await harness.snapshot(JobBoardDoc, context)) ?? {
          nextNumber: 1,
          jobs: {},
          byConversation: {},
          queue: [],
        },
        budgetJobs: payers.waiting(),
        mode: "shadow",
        capacity: { measured: null, at: null },
        templates: [],
        waiting: 0,
        resetsAt: nextMonthUtc(now()),
        now: now(),
        timeZone: "UTC",
      }),
    wakes: async () => {
      const summary = wakesOf(await harness.inspect(context));
      return { summary, next: nextWake(summary, now()) };
    },
    exchange: async (request) => {
      const deps = { task, budgets: options.budgets, now, waiting: () => payers.waiting() };
      const { answer, applied } = await exchange(harness, request, deps, context);
      const quiet = withoutAbortSignal(context);
      for (const taskId of applied.aborts) await harness.abortTask(taskId, quiet);
      for (const n of applied.started) holds.wake(n);
      if (applied.started.length > 0) {
        // After the commit, so a retried exchange never logs a start twice.
        const shared = await harness.snapshot(SharedJobsDoc, quiet);
        for (const n of applied.started) {
          const entry = shared?.jobs[String(n)];
          logEvent("shared.started", {
            cell,
            job: n,
            requester: entry?.requester ?? null,
            other: entry?.other ?? null,
          });
        }
      }
      const stopping = applied.stops.flatMap((each) => each.jobs);
      if (stopping.length > 0) await stop("person", stopping);
      // Only now are the stop and aborts done: a household that ended before this point runs them
      // again when the person repeats the operation.
      if (applied.pending.length > 0) {
        await harness.commit((tx) => effectsDone(tx, applied.pending), quiet);
      }
      if (applied.aborts.length === 0 && stopping.length === 0) return answer;
      const over = overOf(await options.budgets());
      const rows = await harness.commit(
        (tx) => rowsFor(tx, request.person, over, payers.waiting()),
        quiet,
      );
      return { acks: answer.acks, rows };
    },
    close: async () => {
      reports.flush();
      await harness.close(context);
    },
  };
}
