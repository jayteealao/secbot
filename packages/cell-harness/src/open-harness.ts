/**
 * Opens one person's harness on a celld cell's storage: the lead's root conversation, the four
 * specialists, the hand-off, history, household, and reminder tools, the routines (heartbeat,
 * reminders), the model gateway, and model health. Host API: `Harness.open`, `root`, `resume`
 * (pi-durable v1.0.3 README "Quick Start", "Persist and Resume").
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  type Harness,
  Harness as HarnessFactory,
  type Submission,
} from "@earendil-works/pi-durable";
import {
  type CelldSqliteDatabase,
  type CelldStorage,
  openCelldStorageWithDatabase,
} from "@secbot/cell-storage";
import { type AlertEnv, createAlerts } from "./alerts.ts";
import { type CellParts, logEvent } from "./cell-parts.ts";
import { type LeadMessage, markDelivered, missedMessages } from "./delivery.ts";
import { ModelHealthDoc, RosterDoc } from "./docs.ts";
import { createGatewayModels, type GatewayEnv } from "./gateway.ts";
import { createHandoffExtension } from "./handoff.ts";
import { createHeartbeatRoutine, type HeartbeatEnv } from "./heartbeat.ts";
import { createHistoryExtension } from "./history-search.ts";
import { createHouseholdExtension, type HouseholdClient } from "./household-tools.ts";
import { ModelHealthMonitor } from "./model-health.ts";
import { listRoleModels, type RoleModel, setRoleModel } from "./model-map.ts";
import { LEAD_ROLE } from "./release-defaults.ts";
import {
  createReminderExtension,
  createReminderRoutine,
  type ReminderPayload,
} from "./reminder.ts";
import { addSpecialist, ensureRoster } from "./roster.ts";
import { ensureRoutines, type Routine } from "./routines.ts";
import { createLeadExtension, type TimeEnv, timeZoneOf } from "./sections.ts";
import { type Frame, openSessionStream, type SessionStream } from "./session-stream.ts";
import { cellSettings } from "./settings.ts";
import { createTelemetryExtension } from "./telemetry.ts";
import {
  type NextWake,
  nextWake,
  ROUTINE_KIND_PREFIX,
  type WakeSummary,
  wakesOf,
} from "./wake-times.ts";

export interface CellEnv extends GatewayEnv, AlertEnv, HeartbeatEnv, TimeEnv {}

export interface OpenCellOptions {
  readonly person: string;
  readonly version: string;
  readonly env: CellEnv;
  /** Tests: a model collection in place of the OpenRouter gateway. */
  readonly models?: Models;
  /** Tests: a clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Tests: the fetch used for alerts and heartbeat pings. */
  readonly fetch?: typeof fetch;
  /** The household cell; the household tools report it unreachable without one. */
  readonly household?: HouseholdClient;
  /** Called after every commit that changes a wake time (a routine ran, a reminder was set). */
  readonly onWakeChange?: () => void;
  /** More recurring routines beside the heartbeat (later packets: the morning briefing). */
  readonly routines?: readonly { readonly routine: Routine; readonly firstWakeMs?: number }[];
}

export interface CellStatus {
  readonly status: "up";
  readonly person: string;
  readonly version: string;
  readonly roles: readonly string[];
}

export class CellHarness implements CellParts {
  constructor(
    readonly person: string,
    readonly version: string,
    readonly harness: Harness,
    readonly root: Conversation,
    readonly models: Models,
    readonly extensions: CellParts["extensions"],
    readonly monitor: ModelHealthMonitor,
    /** The storage driver, so cell code can run a transaction in pi-durable's queue. */
    readonly database: CelldSqliteDatabase,
    readonly reminders: Routine<ReminderPayload>,
    readonly now: () => number,
  ) {}

  /** Every durable wake time and the cell's next alarm, from the live tasks' checkpoints. */
  async wakes(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }> {
    const summary = wakesOf(await this.harness.inspect(context));
    return { summary, next: nextWake(summary, this.now()) };
  }

  /** Submits a message to the lead's root conversation, unchanged. Idempotent per request id. */
  submit(
    text: string,
    requestId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Submission> {
    return this.root.submit({ type: "input", content: text, requestId }, context);
  }

  async status(context: Context = BACKGROUND_CONTEXT): Promise<CellStatus> {
    const roster = await this.harness.snapshot(RosterDoc, context);
    return {
      status: "up",
      person: this.person,
      version: this.version,
      roles: [LEAD_ROLE, ...Object.keys(roster?.specialists ?? {})],
    };
  }

  listRoleModels(context: Context = BACKGROUND_CONTEXT): Promise<RoleModel[]> {
    return listRoleModels(this, context);
  }

  setRoleModel(role: string, modelId: string, context: Context = BACKGROUND_CONTEXT) {
    return setRoleModel(this, role, modelId, context);
  }

  addSpecialist(
    input: { readonly name: string; readonly instruction: string; readonly model?: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    return addSpecialist(this, input, context);
  }

  missed(device: string, context: Context = BACKGROUND_CONTEXT): Promise<LeadMessage[]> {
    return missedMessages(this.harness, this.root, device, context);
  }

  markDelivered(device: string, entryId: number, context: Context = BACKGROUND_CONTEXT) {
    return markDelivered(this.harness, device, entryId, context);
  }

  session(send: (frame: Frame) => void, delivered?: (entryId: number) => void | Promise<void>) {
    return openSessionStream(this.harness, send, delivered) as Promise<SessionStream>;
  }

  async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.monitor.settled();
    await this.harness.close(context);
  }
}

export async function openCellHarness(
  storage: CelldStorage,
  options: OpenCellOptions,
  context: Context = BACKGROUND_CONTEXT,
): Promise<CellHarness> {
  const started = Date.now();
  const { person, env } = options;
  const now = options.now ?? (() => Date.now());
  const onReport = (error: unknown) =>
    logEvent("harness.report", {
      cell: person,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  const monitor = new ModelHealthMonitor({
    person,
    alerts: createAlerts(env, person, options.fetch),
    now,
    onReport,
  });
  let opened: Harness | undefined;
  const current = () => {
    if (opened === undefined) throw new Error("the harness is not open yet");
    return opened;
  };
  const hooks = {
    cell: person,
    ...(options.onWakeChange === undefined ? {} : { onWakeChange: options.onWakeChange }),
  };
  const timeZone = timeZoneOf(env);
  const heartbeat = createHeartbeatRoutine(env, hooks, options.fetch);
  const reminders = createReminderRoutine(hooks);
  const lead = createLeadExtension({ now, timeZone });
  const handoff = createHandoffExtension(person);
  const history = createHistoryExtension(current);
  const household = createHouseholdExtension(person, () => options.household);
  const reminder = createReminderExtension(reminders, { ...hooks, now, timeZone });
  const recurring = [{ routine: heartbeat }, ...(options.routines ?? [])];
  const routines = defineExtension({
    name: "secbot-routines",
    tasks: recurring.map(({ routine }) => routine.task),
  });
  const telemetry = createTelemetryExtension(person, monitor);
  const extensions = {
    lead: [lead, handoff, history, household, reminder, routines, telemetry],
    specialist: [history, household, telemetry],
  };
  const registry = createRegistry();
  for (const extension of extensions.lead) registry.install(extension);
  const models = options.models ?? createGatewayModels(env);
  const durable = await openCelldStorageWithDatabase(storage);
  const harness = await HarnessFactory.open(
    durable.storage,
    { models, registry, settings: cellSettings(extensions.specialist), now, onReport },
    context,
  );
  opened = harness;
  monitor.attach(harness);
  const root = await harness.root(context);
  const cell = new CellHarness(
    person,
    options.version,
    harness,
    root,
    models,
    extensions,
    monitor,
    durable.database,
    reminders,
    now,
  );
  // What the last run left: live work, and routines whose time passed while the cell was down.
  // Read before this open creates anything and before resume(), so nothing has run yet.
  const left = (await harness.inspect(context)).tasks;
  const created = await ensureRoster(cell, context);
  await harness.commit(async (tx) => {
    await tx.doc(ModelHealthDoc);
  }, context);
  const routineTasks = left.filter(({ record }) => record.kind.startsWith(ROUTINE_KIND_PREFIX));
  const overdue = wakesOf({ tasks: routineTasks }).wakes.filter((wake) => wake.at <= now()).length;
  const pendingWork = left.length - routineTasks.length;
  await ensureRoutines(harness, recurring, now(), context);
  const pending = (await harness.inspect(context)).tasks.length;
  harness.resume();
  if (pendingWork > 0 || overdue > 0) {
    logEvent("harness.recovered", {
      cell: person,
      pending_tasks: pendingWork,
      overdue_routines: overdue,
      duration_ms: Date.now() - started,
    });
  }
  logEvent("harness.opened", {
    cell: person,
    version: options.version,
    roles: (await cell.status(context)).roles,
    specialists_created: created,
    pending_tasks_resumed: pending,
    duration_ms: Date.now() - started,
  });
  return cell;
}
