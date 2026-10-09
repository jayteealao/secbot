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
  type DocumentWatch,
  defineExtension,
  type Extension,
  type Harness,
  Harness as HarnessFactory,
  ROOT_CONVERSATION_ID,
  type Submission,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import {
  type CelldSqliteDatabase,
  type CelldStorage,
  openCelldStorageWithDatabase,
} from "@secbot/cell-storage";
import {
  type ActivityQuery,
  type ActivityView,
  listActivity,
  monthItemCost,
  monthOf,
} from "./activity.ts";
import { type AlertEnv, createAlerts } from "./alerts.ts";
import {
  type AnswerChoice,
  type Answered,
  answerHeld,
  defaultSetTimer,
  type HeldCallView,
  listHeld,
  type SetTimer,
} from "./approvals.ts";
import { BudgetGate, createBudgetExtension } from "./budget-gate.ts";
import { type CellParts, errorFields, logEvent } from "./cell-parts.ts";
import { createDecisionModels, type DecisionModels, parseThresholdCaps } from "./decision-model.ts";
import { type MissedPage, markDelivered, missedPage } from "./delivery.ts";
import {
  ApprovalsDoc,
  BudgetWaitsDoc,
  DecisionModelDoc,
  type GuardMode,
  GuardModeDoc,
  HouseholdBudgetDoc,
  JobsDoc,
  type LimitNotice,
  LimitNoticesDoc,
  LimitsDoc,
  ModelHealthDoc,
  MonthLedgerDoc,
  NoticeDeliveryDoc,
  RosterDoc,
} from "./docs.ts";
import { createGatewayModels, type GatewayEnv } from "./gateway.ts";
import { createGuardExtension, createModelStage, type GuardOptions, ruleStage } from "./guard.ts";
import {
  type GuardModeState,
  readDecisionAdapter,
  readGuardMode,
  setDecisionAdapter,
  setGuardMode,
} from "./guard-settings.ts";
import { createHandoffExtension } from "./handoff.ts";
import { createHeartbeatRoutine, type HeartbeatEnv } from "./heartbeat.ts";
import { createHistoryExtension } from "./history-search.ts";
import { createHouseholdExtension, type HouseholdClient } from "./household-tools.ts";
import { liveJobs } from "./jobs.ts";
import {
  type BudgetState,
  budgetState,
  type CostView,
  costViewOf,
  LimitWatch,
  markNoticeSeen,
  setLimit,
  type UsageLine,
  unseenNotices,
  type WaitingItem,
  waitingList,
} from "./limits.ts";
import { ModelHealthMonitor } from "./model-health.ts";
import { listRoleModels, type RoleModel, setRoleModel } from "./model-map.ts";
import { ledgerConversations } from "./month-ledger.ts";
import { type DecisionAdapter, LEAD_ROLE } from "./release-defaults.ts";
import {
  createReminderExtension,
  createReminderRoutine,
  type ReminderPayload,
} from "./reminder.ts";
import { createReviewer, type Reviewer } from "./reviewer.ts";
import { addSpecialist, ensureRoster } from "./roster.ts";
import { ensureRoutines, type Routine } from "./routines.ts";
import { addRule, listRules, type RuleLists, removeRule, seedRules } from "./rule-store.ts";
import type { Rule, RuleLevel } from "./rules.ts";
import { createSecretsExtension, redactionLoader, type SecretsClient } from "./secret-tools.ts";
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

export interface CellEnv extends GatewayEnv, AlertEnv, HeartbeatEnv, TimeEnv {
  /** Test cell only: per-tool caps on the mark threshold, as JSON (parseThresholdCaps). */
  readonly SECBOT_MARK_THRESHOLD_CAPS?: string;
}

/** The cell's limit watch and budget gate (limits.ts, budget-gate.ts). */
export interface CellBudget {
  readonly watch: LimitWatch;
  readonly gate: BudgetGate;
  /** Stops the watches of the cell's `pi.usage` documents. */
  readonly stop: () => Promise<void>;
}

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
  /** The secrets cell; the secret tools answer "secrets cell unavailable" without one. */
  readonly secrets?: SecretsClient;
  /** Called after every commit that changes a wake time (a routine ran, a reminder was set). */
  readonly onWakeChange?: () => void;
  /** More recurring routines beside the heartbeat (for example a morning briefing). */
  readonly routines?: readonly { readonly routine: Routine; readonly firstWakeMs?: number }[];
  /** Tests: more extensions for every role, after the release ones (the guard stays first). */
  readonly extensions?: readonly Extension[];
  /**
   * Tests and later inputs: the held-call request id, the hold length, and the lapse timer; tests
   * also replace the decision model (default: the Decisions API with the cell's OpenRouter key)
   * and the reviewer (default: the reviewer role's model through the cell's gateway).
   */
  readonly guard?: Pick<GuardOptions, "requestIdOf" | "holdMs" | "setTimer"> & {
    /** Tests: the timer the budget gate waits on (the guard's `setTimer` when absent). */
    readonly budgetTimer?: SetTimer;
    readonly decision?: DecisionModels;
    readonly reviewer?: Reviewer;
    /** Tests: a shorter reviewer timeout for the default reviewer. */
    readonly reviewerTimeoutMs?: number;
  };
}

/**
 * Missed messages, the held calls waiting for an answer (listed first), and the limit notices
 * this device has not seen (after held calls), with the work waiting above a limit.
 */
export interface MissedWithHeld extends MissedPage {
  readonly held: readonly HeldCallView[];
  readonly notices: readonly LimitNotice[];
  readonly waiting: readonly WaitingItem[];
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
    /** The cell's time zone: activity months and times are read in it. */
    readonly timeZone: string,
    /** The limit watch and the budget gate. */
    readonly budget: CellBudget,
    /** Routines that spend nothing (the heartbeat): activity does not list them as jobs. */
    readonly quietRoutines: ReadonlySet<string> = new Set(),
  ) {}

  private limitParts() {
    return { person: this.person, harness: this.harness, now: this.now, timeZone: this.timeZone };
  }

  /** Both budgets against their limits (the month rolls first when it ended). */
  budgetState(context: Context = BACKGROUND_CONTEXT): Promise<BudgetState> {
    return budgetState(this.limitParts(), context);
  }

  /** The person's month: spend by layer and role, the limit, the mode, and what waits. */
  async cost(context: Context = BACKGROUND_CONTEXT): Promise<CostView> {
    const state = await this.budgetState(context);
    const mode = await readGuardMode(this.harness, context);
    return costViewOf(this.person, state, mode, await this.waiting(context));
  }

  /** The usage line of a chat session. */
  async usage(context: Context = BACKGROUND_CONTEXT): Promise<UsageLine> {
    const { person, spend } = await this.budgetState(context);
    const { mode } = await readGuardMode(this.harness, context);
    return {
      month: spend.month,
      zone: spend.zone,
      resetsAt: spend.resetsAt,
      spentUsd: person.spentUsd,
      limitUsd: person.limitUsd,
      percent: person.percent,
      line: person.line,
      mode,
    };
  }

  /** The tasks waiting above a limit, oldest first. */
  waiting(context: Context = BACKGROUND_CONTEXT): Promise<WaitingItem[]> {
    return waitingList(this.harness, context);
  }

  /**
   * The owner sets this person's monthly limit; the next call (and every waiting task) uses it.
   * RefusedChange for an amount that is not above 0 and at most 10 000 with two decimals.
   */
  async setLimit(usd: unknown, by: string, context: Context = BACKGROUND_CONTEXT) {
    const result = await setLimit(this.limitParts(), usd, by, context);
    this.budget.gate.wake();
    this.budget.watch.trigger();
    return result;
  }

  /**
   * Reads the household budget board (when the household cell has one) and keeps its settings:
   * the developer budget, the time zone from the next month, and the other cells' developer spend.
   */
  async refreshHouseholdBudget(household: HouseholdClient | undefined): Promise<void> {
    if (household?.budget === undefined) return;
    const board = await household.budget();
    const month = (await this.harness.snapshot(MonthLedgerDoc, BACKGROUND_CONTEXT))?.month ?? "";
    const others = board.reports
      .filter((report) => report.cell !== this.person && report.month === month)
      .reduce((sum, report) => sum + report.developerUsd, 0);
    if (await this.budget.watch.keepSettings(board.settings, others)) {
      this.budget.gate.wake();
      this.budget.watch.trigger();
    }
  }

  /** The limit notices this device has not seen; `mark` moves its cursor past them. */
  notices(device: string, mark = false, context: Context = BACKGROUND_CONTEXT) {
    return unseenNotices(this.harness, device, mark, context);
  }

  markNoticeSeen(device: string, seq: number, context: Context = BACKGROUND_CONTEXT) {
    return markNoticeSeen(this.harness, device, seq, context);
  }

  /** The owner's rules and the person's rules. */
  rules(context: Context = BACKGROUND_CONTEXT): Promise<RuleLists> {
    return listRules(this, context);
  }

  /** Adds a rule; a person rule looser than an owner rule is refused (RefusedChange). */
  addRule(level: RuleLevel, input: unknown, context: Context = BACKGROUND_CONTEXT): Promise<Rule> {
    return addRule(this, level, input, this.now(), context);
  }

  /** Removes the rule with this agent, tool, and match (RuleNotFound when none matches). */
  removeRule(
    level: RuleLevel,
    input: unknown,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Rule> {
    return removeRule(this, level, input, context);
  }

  /**
   * One month of activity, newest first: the stored records (guard verdicts, held calls and their
   * answers and lapses, finished jobs), the person's spend in the month, and, on the first page of
   * the current month, the jobs running or waiting now.
   */
  async activity(
    query: ActivityQuery = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ActivityView> {
    const now = this.now();
    const page = await listActivity(
      this.harness,
      { ...query, now, timeZone: this.timeZone },
      context,
    );
    const current = page.month === monthOf(now, this.timeZone) && query.before === undefined;
    const live = current
      ? await liveJobs(
          this.harness,
          { now, timeZone: this.timeZone, quiet: this.quietRoutines },
          context,
        )
      : [];
    return { ...page, spentUsd: await this.monthSpent(page.month, context), live };
  }

  /**
   * The person's spend in `month`: the month ledger's month to date when the months agree, the
   * total the ledger kept when the month ended, else the sum of the month's stored item costs (a
   * month before the ledger kept totals, or a month key that differs because activity months use
   * the cell's zone and the ledger the household zone).
   */
  private async monthSpent(month: string, context: Context): Promise<number> {
    const { spend, person } = await this.budgetState(context);
    if (spend.month === month) return person.spentUsd;
    const closed = (await this.harness.snapshot(MonthLedgerDoc, context))?.closed;
    const kept = closed !== undefined && Object.hasOwn(closed, month) ? closed[month] : undefined;
    return kept ?? monthItemCost(this.harness, month, context);
  }

  /** The guard mode (shadow or enforce), since when, and the decision model's adapter. */
  async guardMode(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<GuardModeState & { readonly decisionModel: DecisionAdapter }> {
    return {
      ...(await readGuardMode(this.harness, context)),
      decisionModel: await readDecisionAdapter(this.harness, context),
    };
  }

  /** The owner switches the mode; the next call the model stage sees uses it. */
  setGuardMode(mode: GuardMode, by: string, context: Context = BACKGROUND_CONTEXT) {
    return setGuardMode(this, mode, by, this.now(), context);
  }

  /** The owner switches the decision model (clef or jev); the next call uses it. */
  setDecisionAdapter(adapter: string, context: Context = BACKGROUND_CONTEXT) {
    return setDecisionAdapter(this, adapter, context);
  }

  /**
   * Every durable wake time and the cell's next alarm, from the live tasks' checkpoints. Work
   * waiting above a limit is timed at the month reset, and the month reset is always a wake, so an
   * idle cell rolls its month on time.
   */
  async wakes(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }> {
    const ledger = await this.harness.snapshot(MonthLedgerDoc, context);
    const waits = await this.harness.snapshot(BudgetWaitsDoc, context);
    const resetsAt = ledger === undefined || ledger.month === "" ? undefined : ledger.endsAt;
    const summary = wakesOf(
      await this.harness.inspect(context),
      resetsAt === undefined
        ? undefined
        : { taskIds: new Set(Object.keys(waits?.tasks ?? {})), resetsAt },
    );
    const next = nextWake(summary, this.now());
    if (resetsAt !== undefined && (next === undefined || resetsAt < next.at)) {
      return { summary, next: { at: resetsAt, source: "month-reset" } };
    }
    return { summary, next };
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

  /**
   * The held calls waiting for an answer (oldest first), then the oldest messages this device has
   * not seen, and how many newer ones are left.
   */
  async missed(device: string, context: Context = BACKGROUND_CONTEXT): Promise<MissedWithHeld> {
    const held = await this.heldCalls(context);
    const notices = await this.notices(device, true, context);
    const waiting = notices.length === 0 ? [] : await this.waiting(context);
    return {
      held,
      notices,
      waiting,
      ...(await missedPage(this.harness, this.root, device, context)),
    };
  }

  /** The held calls waiting for an answer, oldest first; an expired one is lapsed and left out. */
  heldCalls(context: Context = BACKGROUND_CONTEXT): Promise<HeldCallView[]> {
    return listHeld(this, this.now(), context);
  }

  /**
   * Answers held call `number`: allow once, allow always (adds a person rule), or deny. Refusals:
   * NoHeldCall, HeldCallLapsed, HeldCallAnswered, AlwaysNotOffered, RefusedChange.
   */
  answer(
    number: number,
    choice: AnswerChoice,
    by: { readonly device: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Answered> {
    return answerHeld(
      this,
      number,
      choice,
      { person: this.person, device: by.device },
      this.now(),
      context,
    );
  }

  markDelivered(device: string, entryId: number, context: Context = BACKGROUND_CONTEXT) {
    return markDelivered(this.harness, device, entryId, context);
  }

  session(send: (frame: Frame) => void, delivered?: (entryId: number) => void | Promise<void>) {
    return openSessionStream(this.harness, send, delivered, this.now, {
      usage: () => this.usage(),
      waiting: () => this.waiting(),
    }) as Promise<SessionStream>;
  }

  async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.budget.stop();
    await this.budget.watch.settled();
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
    logEvent("harness.report", reportFields(person, error), "error");
  const alerts = createAlerts(env, person, options.fetch);
  const monitor = new ModelHealthMonitor({ person, alerts, now, onReport });
  let opened: Harness | undefined;
  const current = () => {
    if (opened === undefined) throw new Error("the harness is not open yet");
    return opened;
  };
  const timeZone = timeZoneOf(env);
  // Above a limit, hand-offs, routines, reminders, and specialist jobs wait here (budget-gate.ts).
  const gate = new BudgetGate({
    person,
    harness: current,
    state: (context) => budgetState({ person, harness: current(), now, timeZone }, context),
    now,
    setTimer: options.guard?.budgetTimer ?? options.guard?.setTimer ?? defaultSetTimer,
    ...(options.onWakeChange === undefined ? {} : { onWakeChange: options.onWakeChange }),
  });
  const hooks = {
    cell: person,
    gate: () => gate,
    timeZone,
    ...(options.onWakeChange === undefined ? {} : { onWakeChange: options.onWakeChange }),
  };
  const heartbeat = createHeartbeatRoutine(env, hooks, options.fetch);
  const reminders = createReminderRoutine(hooks);
  const lead = createLeadExtension({ now, timeZone });
  const handoff = createHandoffExtension(person, () => gate, timeZone);
  const history = createHistoryExtension(current);
  const household = createHouseholdExtension(person, () => options.household);
  // Granted values reach the redactor at open (best effort) and before each secrets call.
  const loadRedaction = redactionLoader(person, () => options.secrets);
  const secrets = createSecretsExtension(
    person,
    () => options.secrets,
    { now, timeZone },
    loadRedaction,
  );
  loadRedaction().catch(() => {});
  const reminder = createReminderExtension(reminders, { ...hooks, now, timeZone });
  const recurring = [{ routine: heartbeat }, ...(options.routines ?? [])];
  const routines = defineExtension({
    name: "secbot-routines",
    tasks: recurring.map(({ routine }) => routine.task),
  });
  const telemetry = createTelemetryExtension(person, monitor);
  const models = options.models ?? createGatewayModels(env);
  const {
    decision: decisionOption,
    reviewer: reviewerOption,
    reviewerTimeoutMs,
    budgetTimer: _budgetTimer,
    ...guardOptions
  } = options.guard ?? {};
  // The decision model and the reviewer run after the rules, on calls the rules passed.
  const modelStage = createModelStage({
    decision:
      decisionOption ??
      createDecisionModels({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        thresholdCaps: parseThresholdCaps(env.SECBOT_MARK_THRESHOLD_CAPS),
      }),
    reviewer:
      reviewerOption ??
      createReviewer({
        models: () => models,
        reader: current,
        ...(reviewerTimeoutMs === undefined ? {} : { timeoutMs: reviewerTimeoutMs }),
      }),
    // A guard model call that answers 402 or 403 puts the cell in the credit pause, as an agent
    // call does; the call's own outcome stays the guard's (fail closed).
    onCredit: (status) =>
      monitor.report({ kind: "failure", error: `${status} credit limit`, credit: true }),
  });
  // The guard is first in every role's list and in the default list, so every role (and a
  // specialist added after start) runs it before any tool call.
  const guard = createGuardExtension(person, current, {
    now,
    timeZone,
    stages: [ruleStage, modelStage],
    ...guardOptions,
  });
  const extra = options.extensions ?? [];
  // The budget extension is on every specialist's list, after the guard, and never on the lead's:
  // above a limit a specialist's job waits before its next request; chat with the lead runs.
  const budget = createBudgetExtension(() => gate);
  const extensions = {
    lead: [
      guard,
      lead,
      handoff,
      history,
      household,
      secrets,
      reminder,
      routines,
      telemetry,
      ...extra,
    ],
    specialist: [guard, budget, history, household, secrets, telemetry, ...extra],
  };
  const registry = createRegistry();
  for (const extension of new Set([...extensions.lead, ...extensions.specialist])) {
    registry.install(extension);
  }
  const durable = await openCelldStorageWithDatabase(storage);
  const harness = await HarnessFactory.open(
    durable.storage,
    { models, registry, settings: cellSettings(extensions.specialist), now, onReport },
    context,
  );
  opened = harness;
  try {
    return await finishOpen(harness, options, context, {
      started,
      now,
      monitor,
      extensions,
      models,
      database: durable.database,
      reminders,
      recurring,
      timeZone,
      alerts,
      gate,
      onReport,
    });
  } catch (error) {
    // A failure after the open (roster, routines, inspect) must not leave this harness running on
    // the storage while the next event opens a second one.
    await harness.close(context).catch(() => {});
    throw error;
  }
}

/** `harness.report` fields: the error's class, a safe message, and the head of its stack. */
export function reportFields(cell: string, error: unknown): Record<string, unknown> {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const head = stack
    .split("\n")
    .slice(1, 3)
    .map((line) => line.trim())
    .join(" | ");
  return { cell, ...errorFields(error), stack_head: head.slice(0, 200) };
}

async function finishOpen(
  harness: Harness,
  options: OpenCellOptions,
  context: Context,
  parts: {
    readonly started: number;
    readonly now: () => number;
    readonly monitor: ModelHealthMonitor;
    readonly extensions: CellParts["extensions"];
    readonly models: Models;
    readonly database: CelldSqliteDatabase;
    readonly reminders: Routine<ReminderPayload>;
    readonly recurring: readonly { readonly routine: Routine; readonly firstWakeMs?: number }[];
    readonly timeZone: string;
    readonly alerts: ReturnType<typeof createAlerts>;
    readonly gate: BudgetGate;
    readonly onReport: (error: unknown) => void;
  },
): Promise<CellHarness> {
  const { person } = options;
  const { started, now, monitor, extensions, models, reminders, recurring } = parts;
  monitor.attach(harness);
  const root = await harness.root(context);
  const watch = new LimitWatch({
    person,
    harness,
    now,
    timeZone: parts.timeZone,
    alerts: parts.alerts,
    household: () => options.household,
    mode: (modeContext) => readGuardMode(harness, modeContext),
    onChange: () => parts.gate.wake(),
    onReport: parts.onReport,
  });
  let stopWatches: () => Promise<void> = async () => {};
  const cell = new CellHarness(
    person,
    options.version,
    harness,
    root,
    models,
    extensions,
    monitor,
    parts.database,
    reminders,
    now,
    parts.timeZone,
    { watch, gate: parts.gate, stop: () => stopWatches() },
    new Set(
      [...recurring.map(({ routine }) => routine), reminders]
        .filter((routine) => !routine.spends)
        .map((routine) => routine.name),
    ),
  );
  // What the last run left: live work, and routines whose time passed while the cell was down.
  // Read before this open creates anything and before resume(), so nothing has run yet.
  const left = (await harness.inspect(context)).tasks;
  const created = await ensureRoster(cell, context);
  await harness.commit(async (tx) => {
    await tx.doc(ModelHealthDoc);
    // Sessions watch the held-call list from the start.
    await tx.doc(ApprovalsDoc);
    // The release owner rule and the default person rules, once per cell (existing cells too).
    await seedRules(tx, now());
    // Every cell, existing ones too, starts in shadow mode on the default decision model.
    const mode = await tx.doc(GuardModeDoc);
    if (mode.since === null) mode.since = now();
    await tx.doc(DecisionModelDoc);
    // Limits: the person's limit, notices, waits, and the household settings the board last gave.
    await tx.doc(LimitsDoc);
    await tx.doc(LimitNoticesDoc);
    await tx.doc(NoticeDeliveryDoc);
    await tx.doc(BudgetWaitsDoc);
    await tx.doc(HouseholdBudgetDoc);
    // The cost marks of hand-off jobs (activity).
    await tx.doc(JobsDoc);
    // Each conversation's ledger exists, so the limit watch can watch it from the start.
    await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
    for (const record of Object.values((await tx.doc(RosterDoc)).specialists)) {
      await tx.doc(UsageDoc, record.conversationId);
    }
  }, context);
  const routineTasks = left.filter(({ record }) => record.kind.startsWith(ROUTINE_KIND_PREFIX));
  const overdue = wakesOf({ tasks: routineTasks }).wakes.filter((wake) => wake.at <= now()).length;
  const pendingWork = left.length - routineTasks.length;
  await ensureRoutines(harness, recurring, now(), context);
  const pending = (await harness.inspect(context)).tasks.length;
  stopWatches = await watchSpend(harness, () => watch.trigger(), context);
  // The first evaluation starts (or rolls) the month.
  watch.trigger();
  harness.resume();
  if (options.household?.budget !== undefined) {
    // Best effort: the board's settings arrive with the next spend report anyway.
    cell.refreshHouseholdBudget(options.household).catch(parts.onReport);
  }
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

/**
 * Calls `trigger` after every committed change of any conversation's `pi.usage` (a specialist
 * added later included, through a watch of the roster). Returns a function that stops the watches.
 */
async function watchSpend(
  harness: Harness,
  trigger: () => void,
  context: Context,
): Promise<() => Promise<void>> {
  const watches = new Map<string, DocumentWatch<UsageState>>();
  const ensure = async () => {
    for (const { id, conversationId } of await ledgerConversations(harness, context)) {
      if (watches.has(conversationId)) continue;
      let watch = await harness.watchDoc(UsageDoc, id, context);
      if (watch === undefined) {
        // A conversation created after the open has no ledger document until its first cost.
        await harness.commit(async (tx) => {
          await tx.doc(UsageDoc, id);
        }, context);
        watch = await harness.watchDoc(UsageDoc, id, context);
      }
      if (watch === undefined || watches.has(conversationId)) continue;
      watches.set(conversationId, watch);
      watch.start(async () => trigger());
    }
  };
  await ensure();
  const roster = await harness.watchDoc(RosterDoc, context);
  roster?.start(async () => {
    await ensure();
    trigger();
  });
  return async () => {
    await roster?.stop();
    for (const watch of watches.values()) await watch.stop();
  };
}
