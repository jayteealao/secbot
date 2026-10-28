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
  needsReopen,
  openCelldStorageWithDatabase,
} from "@secbot/cell-storage";
import {
  type ActivityQuery,
  type ActivityView,
  listActivity,
  monthItemCost,
  monthKey,
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
import { createBookmarkExtension, recordInterruption } from "./bookmark.ts";
import { BudgetGate, createBudgetExtension } from "./budget-gate.ts";
import { type CellParts, errorFields, logEvent } from "./cell-parts.ts";
import { createContentCheckExtension } from "./content-check.ts";
import { createDecisionModels, type DecisionModels, parseThresholdCaps } from "./decision-model.ts";
import { type MissedPage, markDelivered, missedPage } from "./delivery.ts";
import {
  ApprovalsDoc,
  BookmarkDoc,
  BudgetWaitsDoc,
  DecisionModelDoc,
  type GuardMode,
  GuardModeDoc,
  HouseholdBudgetDoc,
  JobBoardDoc,
  JobsDoc,
  type LimitNotice,
  LimitNoticesDoc,
  LimitsDoc,
  ModelHealthDoc,
  MonthLedgerDoc,
  NoticeDeliveryDoc,
  ReceiptsDoc,
  RosterDoc,
  TemplatesDoc,
  TierSettingsDoc,
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
import { createLegacyHandoffExtension } from "./handoff.ts";
import { createHeartbeatRoutine, type HeartbeatEnv } from "./heartbeat.ts";
import { createHistoryExtension } from "./history-search.ts";
import { createHouseholdExtension, type HouseholdClient } from "./household-tools.ts";
import { answerQuestion, ENDED, openQuestion } from "./job-board.ts";
import { createJobGate } from "./job-gate.ts";
import { JobHolds } from "./job-holds.ts";
import type { JobTask } from "./job-task.ts";
import { createJobToolsExtension } from "./job-tools.ts";
import { liveJobs } from "./jobs.ts";
import { createJobsExtension } from "./lead-tools.ts";
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
import { listRoleModels, type RoleModel, setRoleModel, setTierCap } from "./model-map.ts";
import { ledgerConversations } from "./month-ledger.ts";
import { createFixtureReaderExtension } from "./outside-tools.ts";
import type { ReceiptTask } from "./receipts.ts";
import type { DecisionAdapter, OutsideKind } from "./release-defaults.ts";
import {
  createReminderExtension,
  createReminderRoutine,
  type ReminderPayload,
} from "./reminder.ts";
import { createReviewer, type Reviewer } from "./reviewer.ts";
import { addTemplate, ensureRoster } from "./roster.ts";
import { ensureRoutines, type Routine } from "./routines.ts";
import {
  addRule,
  listRules,
  type RuleLists,
  releaseRulesAdded,
  removeRule,
  seedRules,
  topUpOwnerRules,
} from "./rule-store.ts";
import type { Rule, RuleLevel } from "./rules.ts";
import { createSecretsExtension, redactionLoader, type SecretsClient } from "./secret-tools.ts";
import { createLeadExtension, type TimeEnv, timeZoneOf } from "./sections.ts";
import { type Frame, openSessionStream, type SessionStream } from "./session-stream.ts";
import { cellSettings } from "./settings.ts";
import { agentNames, createTelemetryExtension } from "./telemetry.ts";
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
  /** How many `pi.usage` documents are watched now. */
  readonly watching: () => number;
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
  /**
   * Called for every background failure, after it is logged as `harness.report` (or counted, for a
   * repeated storage-gone failure), so the cell can react.
   */
  readonly onReport?: (error: unknown) => void;
  /** Tests: how often the count of unlogged storage-gone reports is logged (REPORT_SUMMARY_MS). */
  readonly reportSummaryMs?: number;
  /** More recurring routines beside the heartbeat (for example a morning briefing). */
  readonly routines?: readonly { readonly routine: Routine; readonly firstWakeMs?: number }[];
  /** Tests: more extensions for every role, after the release ones (the guard stays first). */
  readonly extensions?: readonly Extension[];
  /**
   * Tests and the test cell: fixed web pages a job can read with `read_fixture_page`, a reading
   * tool whose content is checked like any other. A cell without them has no fixture tool.
   */
  readonly fixturePages?: Readonly<Record<string, string>>;
  /**
   * Reading tools that later units add with `extensions`, beside the release table: their results
   * are checked before a job keeps them.
   */
  readonly readers?: Readonly<Record<string, OutsideKind>>;
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
    /** The harness's report gate: close logs the count of reports it did not log. */
    private readonly reports?: ReportGate,
  ) {}

  /** The job and receipt tasks (job-task.ts, receipts.ts), set at open. */
  tasks: { readonly job: JobTask; readonly receipt: ReceiptTask } | undefined;

  /** Where paused and questioning jobs wait (job-holds.ts); the gate and the lead share it. */
  holds: JobHolds = new JobHolds();

  /**
   * The person answers a job's question that was put to them. A job waiting on it goes on; the
   * answer to an escalation question (a job that used its raise and its restart) goes to the lead,
   * and the job stays failed.
   */
  async answerJob(
    n: number,
    answer: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<
    | { readonly ok: true; readonly job: number; readonly title: string }
    | { readonly ok: false; readonly reason: "no-job" | "no-question"; readonly message: string }
  > {
    const at = this.now();
    const done = await this.harness.commit(async (tx) => {
      const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
      if (row === undefined) return { ok: false as const, reason: "no-job" as const };
      const open = openQuestion(row);
      if (open === null || !open.toPerson) {
        return { ok: false as const, reason: "no-question" as const };
      }
      const question = await answerQuestion(tx, n, answer, "person", at);
      return {
        ok: true as const,
        title: row.title,
        from: question?.from ?? "job",
        number: question?.number ?? 0,
      };
    }, context);
    if (!done.ok) {
      return {
        ok: false,
        reason: done.reason,
        message: done.reason === "no-job" ? `no job #${n}` : `job ${n} has no question waiting`,
      };
    }
    if (done.from === "escalation") {
      await this.root.submit(
        {
          type: "input",
          content: `[job ${n}: the person answered: ${answer}]`,
          whenBusy: "followUp",
          requestId: `answer:${n}:${done.number}`,
        },
        context,
      );
    } else {
      this.holds.wake(n);
    }
    logEvent("job.answered", {
      cell: this.person,
      job: n,
      by: "person",
      answer_chars: answer.length,
    });
    return { ok: true, job: n, title: done.title };
  }

  /** The questions put to the person that wait for their answer, oldest first. */
  async openQuestions(context: Context = BACKGROUND_CONTEXT) {
    const board = await this.board(context);
    return Object.values(board.jobs)
      .flatMap((row) => {
        const open = openQuestion(row);
        return open === null || !open.toPerson
          ? []
          : [{ job: row.number, title: row.title, question: open.text, askedAt: open.askedAt }];
      })
      .sort((a, b) => a.askedAt - b.askedAt || a.job - b.job);
  }

  /** The person's job board, as committed. */
  async board(context: Context = BACKGROUND_CONTEXT) {
    return (
      (await this.harness.snapshot(JobBoardDoc, context)) ?? {
        nextNumber: 1,
        jobs: {},
        byConversation: {},
      }
    );
  }

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
    const ledger = await this.harness.snapshot(MonthLedgerDoc, context);
    const current =
      page.month === monthKey(now, this.timeZone, ledger) && query.before === undefined;
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
   * The person's spend in `month`: the month ledger's month to date for the current month, the
   * total the ledger kept when the month ended, else the sum of the month's stored item costs (a
   * month before the ledger kept totals). Activity pages are keyed by the ledger's months
   * (`monthKey`), so the current page and the ledger name the same month.
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

  /** The owner switches the decision model (clef, clef-flash, or jev); the next call uses it. */
  setDecisionAdapter(adapter: string, context: Context = BACKGROUND_CONTEXT) {
    return setDecisionAdapter(this, adapter, context);
  }

  /**
   * Every durable wake time and the cell's next alarm, from the live tasks' checkpoints. Work
   * waiting above a limit is timed at the month reset, and the month reset is always a wake, so an
   * idle cell rolls its month on time. A reset that has passed is rolled here (the limit watch's
   * evaluation rolls the ledger and lets waiting work continue), so the alarm is never set again
   * to a time already past; when the roll did not happen, the next try is a minute later.
   */
  async wakes(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ readonly summary: WakeSummary; readonly next: NextWake | undefined }> {
    let ledger = await this.harness.snapshot(MonthLedgerDoc, context);
    if (ledger !== undefined && ledger.month !== "" && ledger.endsAt <= this.now()) {
      this.budget.watch.trigger();
      await this.budget.watch.settled();
      ledger = await this.harness.snapshot(MonthLedgerDoc, context);
    }
    const waits = await this.harness.snapshot(BudgetWaitsDoc, context);
    const endsAt = ledger === undefined || ledger.month === "" ? undefined : ledger.endsAt;
    const resetsAt =
      endsAt !== undefined && endsAt <= this.now() ? this.now() + MONTH_ROLL_RETRY_MS : endsAt;
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

  /**
   * Submits a message to the lead's root conversation, unchanged. Idempotent per request id. A
   * person's message steers in by default: it enters after the lead's current reply step, and when
   * the lead is busy the interrupt bookmark records where it was first (bookmark.ts).
   */
  async submit(
    text: string,
    requestId: string,
    options: { readonly whenBusy?: "steer" | "followUp" } = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Submission> {
    const whenBusy = options.whenBusy ?? "steer";
    const bookmark =
      whenBusy === "steer" ? await recordInterruption(this, this.now(), context) : null;
    logEvent("input.steered", {
      cell: this.person,
      request_id: requestId,
      busy: bookmark !== null,
      when_busy: whenBusy,
    });
    return this.root.submit({ type: "input", content: text, requestId, whenBusy }, context);
  }

  /** The cell is up; its roles are the lead, each job template, and each frozen specialist. */
  async status(context: Context = BACKGROUND_CONTEXT): Promise<CellStatus> {
    return {
      status: "up",
      person: this.person,
      version: this.version,
      roles: [...(await agentNames(this.harness, context))],
    };
  }

  listRoleModels(context: Context = BACKGROUND_CONTEXT): Promise<RoleModel[]> {
    return listRoleModels(this, context);
  }

  setRoleModel(role: string, modelId: string, context: Context = BACKGROUND_CONTEXT) {
    return setRoleModel(this, role, modelId, context);
  }

  /** Changes a tier's per-job cap (the owner's `secbot model cap`). */
  setTierCap(tier: string, usd: unknown, context: Context = BACKGROUND_CONTEXT) {
    return setTierCap(this, tier, usd, context);
  }

  addSpecialist(
    input: { readonly name: string; readonly instruction: string; readonly model?: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    return addTemplate(this, input, context);
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
    // First, so the count goes out even when the close below never finishes.
    this.reports?.flush();
    await this.budget.stop();
    await this.budget.watch.settled();
    await this.monitor.settled();
    await this.harness.close(context);
  }
}

/** How often a harness logs the count of storage-gone reports it did not log: 60 s. */
export const REPORT_SUMMARY_MS = 60_000;

/** A month reset that passed but did not roll is tried again this much later. */
export const MONTH_ROLL_RETRY_MS = 60_000;

/** A harness's background failures on their way to the log and to `options.onReport`. */
export interface ReportGate {
  readonly report: (error: unknown) => void;
  /** Logs the count of reports not logged yet, if any. */
  readonly flush: () => void;
}

/**
 * Each report logs one `harness.report` line, except a storage-gone failure (`needsReopen`: celld
 * closed the database, a reset closed the driver, or pi-durable poisoned the session) after the
 * first one of this harness: it never heals in this harness, and a harness whose close cannot
 * finish keeps retrying its work, so each later one is counted, not logged. The count goes out as
 * one `harness.reports_suppressed` line every `summaryMs` while such reports come, and when the
 * harness closes. Every other failure logs as before, and every report reaches `onReport`.
 */
export function createReportGate(
  person: string,
  onReport: ((error: unknown) => void) | undefined,
  summaryMs = REPORT_SUMMARY_MS,
): ReportGate {
  let gone = false;
  let count = 0;
  let firstAt = 0;
  let lastAt = 0;
  let lastError: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (count === 0) return;
    logEvent(
      "harness.reports_suppressed",
      {
        cell: person,
        count,
        first_at: new Date(firstAt).toISOString(),
        last_at: new Date(lastAt).toISOString(),
        ...errorFields(lastError),
      },
      "warn",
    );
    count = 0;
  };
  const report = (error: unknown) => {
    if (gone && needsReopen(error)) {
      const at = Date.now();
      if (count === 0) firstAt = at;
      count++;
      lastAt = at;
      lastError = error;
      timer ??= setTimeout(flush, summaryMs);
    } else {
      if (needsReopen(error)) gone = true;
      logEvent("harness.report", reportFields(person, error), "error");
    }
    try {
      onReport?.(error);
    } catch {
      // A failing listener must not break the report.
    }
  };
  return { report, flush };
}

export async function openCellHarness(
  storage: CelldStorage,
  options: OpenCellOptions,
  context: Context = BACKGROUND_CONTEXT,
): Promise<CellHarness> {
  const started = Date.now();
  const { person, env } = options;
  const now = options.now ?? (() => Date.now());
  const reports = createReportGate(person, options.onReport, options.reportSummaryMs);
  const onReport = reports.report;
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
  const legacy = createLegacyHandoffExtension(person, () => gate, timeZone);
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
  // Paused and questioning jobs wait here; the job gate, the job tools, and the lead's tools share it.
  const holds = new JobHolds();
  const jobGate = createJobGate({ person, harness: current, holds, now });
  const {
    decision: decisionOption,
    reviewer: reviewerOption,
    reviewerTimeoutMs,
    budgetTimer: _budgetTimer,
    ...guardOptions
  } = options.guard ?? {};
  // One decision model for the guard and the content check, on the cell's current adapter.
  const decisionModels =
    decisionOption ??
    createDecisionModels({
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      thresholdCaps: parseThresholdCaps(env.SECBOT_MARK_THRESHOLD_CAPS),
    });
  const readers = options.readers ?? {};
  // The fixture reading tool exists only where fixture pages are given (tests, the test cell).
  const fixtureReader =
    options.fixturePages === undefined ? [] : [createFixtureReaderExtension(options.fixturePages)];
  // Every web page, mail, or file a job reads is checked before the job keeps it, in every mode.
  const contentCheck = createContentCheckExtension({
    person,
    harness: current,
    decision: decisionModels,
    readers,
    now,
  });
  // A job's own tools: search its earlier attempts (no tool that starts a subagent); every tool
  // a job calls is recorded on its row, so a result is marked risky by the tools it used.
  const jobTools = createJobToolsExtension({
    person,
    harness: current,
    holds,
    now,
    wrapped: [
      ...new Set([
        ...[history, household, secrets, ...fixtureReader, ...(options.extensions ?? [])].flatMap(
          (extension) => (extension.tools ?? []).map((tool) => tool.name),
        ),
        ...Object.keys(readers),
      ]),
    ],
  });
  let jobList: readonly Extension[] = [];
  const jobs = createJobsExtension({
    person,
    gate: () => gate,
    timeZone,
    models: () => models,
    jobExtensions: () => jobList,
    now,
    holds,
    harness: current,
    // A result reviewer has no tools: it waits above a limit like a job, and its calls are logged.
    reviewExtensions: () => [budget, telemetry],
    remote: {
      person,
      household: () => options.household,
      secrets: {
        person,
        client: () => options.secrets,
        options: { now, timeZone },
        loadRedaction,
      },
    },
  });
  const bookmark = createBookmarkExtension(person, now);
  // The decision model and the reviewer run after the rules, on calls the rules passed.
  const modelStage = createModelStage({
    decision: decisionModels,
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
    now,
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
  // The budget extension is on every job's list, after the guard, and never on the lead's: above a
  // limit a job waits before its next request; chat with the lead runs.
  const budget = createBudgetExtension(() => gate);
  // The job gate is after the budget: above a limit a job waits there first; then the gate pauses
  // a job at its cap or after three failing steps. The content check is on job lists only: no
  // reading tool is on the lead's list.
  const job = [
    guard,
    budget,
    jobGate,
    contentCheck,
    jobTools,
    history,
    household,
    secrets,
    telemetry,
    ...fixtureReader,
    ...extra,
  ];
  jobList = job;
  const extensions = {
    lead: [
      guard,
      lead,
      jobs.extension,
      bookmark,
      history,
      household,
      secrets,
      reminder,
      routines,
      telemetry,
      ...extra,
    ],
    specialist: job,
    job,
  };
  const registry = createRegistry();
  // The retired hand-off's tasks stay registered so a hand-off in flight at upgrade finishes once.
  for (const extension of new Set([...extensions.lead, ...extensions.job, legacy])) {
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
      reports,
      tasks: { job: jobs.JobTask, receipt: jobs.ReceiptTask },
      holds,
    });
  } catch (error) {
    // A failure after the open (roster, routines, inspect) must not leave this harness running on
    // the storage while the next event opens a second one.
    reports.flush();
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
    readonly reports: ReportGate;
    readonly tasks: { readonly job: JobTask; readonly receipt: ReceiptTask };
    readonly holds: JobHolds;
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
  let spendWatch: SpendWatch = { stop: async () => {}, count: () => 0 };
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
    {
      watch,
      gate: parts.gate,
      stop: () => spendWatch.stop(),
      watching: () => spendWatch.count(),
    },
    new Set(
      [...recurring.map(({ routine }) => routine), reminders]
        .filter((routine) => !routine.spends)
        .map((routine) => routine.name),
    ),
    parts.reports,
  );
  cell.tasks = parts.tasks;
  cell.holds = parts.holds;

  // What the last run left: live work, and routines whose time passed while the cell was down.
  // Read before this open creates anything and before resume(), so nothing has run yet.
  const left = (await harness.inspect(context)).tasks;
  const migrated = await ensureRoster(cell, context);
  const releaseRules = await harness.commit(async (tx) => {
    await tx.doc(ModelHealthDoc);
    // Sessions watch the held-call list from the start.
    await tx.doc(ApprovalsDoc);
    // Every release owner rule the cell lacks (existing cells too), then the default person rules
    // once per cell.
    const added = await topUpOwnerRules(tx, now());
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
    // The cost marks of hand-offs in flight at upgrade (activity).
    await tx.doc(JobsDoc);
    // The job board, receipts, bookmark, custom templates, and tier caps.
    const board = await tx.doc(JobBoardDoc);
    await tx.doc(ReceiptsDoc);
    await tx.doc(BookmarkDoc);
    await tx.doc(TemplatesDoc);
    await tx.doc(TierSettingsDoc);
    for (const row of Object.values(board.jobs)) {
      if (row.conversationId !== null && !ENDED.has(row.status)) {
        await tx.doc(UsageDoc, row.conversationId);
      }
    }
    // Each conversation's ledger exists, so the limit watch can watch it from the start.
    await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
    for (const record of Object.values((await tx.doc(RosterDoc)).specialists)) {
      await tx.doc(UsageDoc, record.conversationId);
    }
    return added;
  }, context);
  releaseRulesAdded(person, releaseRules);
  const routineTasks = left.filter(({ record }) => record.kind.startsWith(ROUTINE_KIND_PREFIX));
  const overdue = wakesOf({ tasks: routineTasks }).wakes.filter((wake) => wake.at <= now()).length;
  const pendingWork = left.length - routineTasks.length;
  await ensureRoutines(harness, recurring, now(), context);
  const pending = (await harness.inspect(context)).tasks.length;
  spendWatch = await watchSpend(person, harness, () => watch.trigger(), context);
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
    templates_migrated: migrated,
    pending_tasks_resumed: pending,
    duration_ms: Date.now() - started,
  });
  return cell;
}

/** The spend watches of one open harness. */
interface SpendWatch {
  readonly stop: () => Promise<void>;
  readonly count: () => number;
}

/**
 * Calls `trigger` after every committed change of any conversation's `pi.usage`: the lead's, each
 * specialist's (one added later included, through a watch of the roster), and each live
 * conversation of a job (through a watch of the board): its current run, an earlier run, and its
 * result review. A watch stops in the pass that sees its conversation done (a run when its row
 * ended or a restart replaced it, a review when its verdict is in), after one last trigger, so the
 * watches of a busy cell do not grow with every job it ever ran.
 */
async function watchSpend(
  person: string,
  harness: Harness,
  trigger: () => void,
  context: Context,
): Promise<SpendWatch> {
  const watches = new Map<string, DocumentWatch<UsageState>>();
  const ended = new Set<string>();
  let pass = Promise.resolve();
  const ensure = async () => {
    const board = await harness.snapshot(JobBoardDoc, context);
    for (const row of Object.values(board?.jobs ?? {})) {
      const done = row.runs.map((run) => run.conversationId);
      if (ENDED.has(row.status)) done.push(row.conversationId);
      if (row.review !== null && row.review.status !== "running") {
        done.push(row.review.conversationId);
      }
      for (const id of done) {
        if (id === null) continue;
        const key = String(id);
        ended.add(key);
        const watch = watches.get(key);
        if (watch === undefined) continue;
        watches.delete(key);
        await watch.stop();
        logEvent("job.watch_closed", {
          cell: person,
          job: row.number,
          conversation_id: key,
          open_watches: watches.size,
        });
      }
    }
    for (const { id, conversationId } of await ledgerConversations(harness, context)) {
      if (watches.has(conversationId) || ended.has(conversationId)) continue;
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
  // One pass at a time: the roster and the board change together when a job starts.
  const again = () => {
    pass = pass
      .then(ensure)
      .then(trigger)
      // A failed pass is logged; the next change runs the next one.
      .catch((error: unknown) =>
        logEvent("spend.watch_failed", { cell: person, ...errorFields(error) }, "warn"),
      );
    return pass;
  };
  await ensure();
  const roster = await harness.watchDoc(RosterDoc, context);
  roster?.start(again);
  const jobs = await harness.watchDoc(JobBoardDoc, context);
  jobs?.start(again);
  return {
    count: () => watches.size,
    stop: async () => {
      await roster?.stop();
      await jobs?.stop();
      await pass.catch(() => {});
      for (const watch of watches.values()) await watch.stop();
    },
  };
}
