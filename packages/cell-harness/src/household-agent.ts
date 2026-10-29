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
import { createBudgetExtension } from "./budget-gate.ts";
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
import { HOUSEHOLD_AGENT_RULES, HOUSEHOLD_AGENT_TOOLS } from "./release-defaults.ts";
import { createReviewTask } from "./result-review.ts";
import { ensureRoutines } from "./routines.ts";
import { cellSettings } from "./settings.ts";
import { type Budgets, createPayerGate, exchange, overOf, rowsFor } from "./shared-jobs.ts";
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
}

export interface HouseholdAgent {
  readonly harness: Harness;
  readonly task: JobTask;
  /** The stored wake times and the next one. */
  wakes(): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }>;
  /** One shared-job exchange with a person cell: their operations in, their shared jobs out. */
  exchange(request: SharedSyncRequest): Promise<SharedSyncAnswer>;
  /** Logs the count of reports not logged yet, then closes the harness. */
  close(): Promise<void>;
}

/** Refuses every tool call of a household job outside its fixed list; nothing is held. */
function householdToolCheck(): Extension {
  return defineExtension({
    name: "secbot-household-tools-only",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) =>
          HOUSEHOLD_JOB_TOOLS.has(call.name) ? undefined : { block: HOUSEHOLD_TOOL_REFUSAL },
      }),
    ],
  });
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
  const jobList: readonly Extension[] = [
    householdToolCheck(),
    budget,
    createJobGate({ person: cell, harness: current, holds, now, relay: true }),
    createJobToolsExtension({
      person: cell,
      harness: current,
      holds,
      now,
      wrapped: [...HOUSEHOLD_AGENT_TOOLS],
      household: true,
    }),
    createHouseholdExtension(cell, () => options.household),
    telemetry,
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
  return {
    harness,
    task,
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
      if (applied.aborts.length === 0) return answer;
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
