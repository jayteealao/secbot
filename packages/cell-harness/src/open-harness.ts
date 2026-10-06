/**
 * Opens one person's harness on a celld cell's storage: the lead's root conversation, the four
 * specialists, the hand-off and history tools, the model gateway, and model health. Host API:
 * `Harness.open`, `root`, `resume` (pi-durable v1.0.3 README "Quick Start", "Persist and Resume").
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  type Harness,
  Harness as HarnessFactory,
  type Submission,
} from "@earendil-works/pi-durable";
import { type CelldStorage, openCelldStorage } from "@secbot/cell-storage";
import { type AlertEnv, createAlerts } from "./alerts.ts";
import { type CellParts, logEvent } from "./cell-parts.ts";
import { type LeadMessage, markDelivered, missedMessages } from "./delivery.ts";
import { ModelHealthDoc, RosterDoc } from "./docs.ts";
import { createGatewayModels, type GatewayEnv } from "./gateway.ts";
import { createHandoffExtension } from "./handoff.ts";
import { createHistoryExtension } from "./history-search.ts";
import { ModelHealthMonitor } from "./model-health.ts";
import { listRoleModels, type RoleModel, setRoleModel } from "./model-map.ts";
import { LEAD_ROLE } from "./release-defaults.ts";
import { addSpecialist, ensureRoster } from "./roster.ts";
import { createLeadExtension } from "./sections.ts";
import { type Frame, openSessionStream, type SessionStream } from "./session-stream.ts";
import { cellSettings } from "./settings.ts";
import { createTelemetryExtension } from "./telemetry.ts";

export interface CellEnv extends GatewayEnv, AlertEnv {}

export interface OpenCellOptions {
  readonly person: string;
  readonly version: string;
  readonly env: CellEnv;
  /** Tests: a model collection in place of the OpenRouter gateway. */
  readonly models?: Models;
  /** Tests: a clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Tests: the fetch used for alerts. */
  readonly fetch?: typeof fetch;
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
  ) {}

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
  const lead = createLeadExtension();
  const handoff = createHandoffExtension(person);
  const history = createHistoryExtension(current);
  const telemetry = createTelemetryExtension(person, monitor);
  const extensions = {
    lead: [lead, handoff, history, telemetry],
    specialist: [history, telemetry],
  };
  const registry = createRegistry();
  for (const extension of extensions.lead) registry.install(extension);
  const models = options.models ?? createGatewayModels(env);
  const harness = await HarnessFactory.open(
    await openCelldStorage(storage),
    { models, registry, settings: cellSettings(extensions.specialist), now, onReport },
    context,
  );
  opened = harness;
  monitor.attach(harness);
  const root = await harness.root(context);
  const cell = new CellHarness(person, options.version, harness, root, models, extensions, monitor);
  const created = await ensureRoster(cell, context);
  await harness.commit(async (tx) => {
    await tx.doc(ModelHealthDoc);
  }, context);
  const pending = (await harness.inspect(context)).tasks.length;
  harness.resume();
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
