/**
 * Limits: each person's monthly limit (25 dollars by default; only the owner changes it, with the
 * operator key) and the household developer budget (50 dollars by default), read against the
 * month ledger (month-ledger.ts). A budget is at "warn" from 80% of its limit and "over" from 100%.
 *
 * The limit watch runs after every committed change of a conversation's `pi.usage`, after a limit
 * change, and after the month rolls. For each line a budget newly reaches it records, in one
 * commit, one notice (shown once per device in chat or in `secbot missed`) and logs one
 * `limit.crossed`; then it sends one owner alert per line (claimed before the send, released when
 * the send fails, so the next evaluation tries again). One evaluation that passes both lines
 * records only the 100% notice and alert. The developer budget is the household's: each cell
 * reports its month to the household budget board, which sums the developer spend of every cell
 * and lets one cell send each developer alert.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader, Harness } from "@earendil-works/pi-durable";
import type { Alerts } from "./alerts.ts";
import { logEvent, RefusedChange } from "./cell-parts.ts";
import {
  type BudgetName,
  BudgetWaitsDoc,
  HouseholdBudgetDoc,
  type LimitNotice,
  LimitNoticesDoc,
  LimitsDoc,
  MonthLedgerDoc,
  NoticeDeliveryDoc,
} from "./docs.ts";
import type { HouseholdClient, SpendReport } from "./household-contract.ts";
import { ALERT_CLAIM_STALE_MS } from "./model-health.ts";
import { ledgerConversations, type MonthSpend, noteHours, readMonth } from "./month-ledger.ts";
import {
  DEFAULT_DEVELOPER_BUDGET_USD,
  DEFAULT_PERSON_LIMIT_USD,
  LIMIT_LINES,
  LIMIT_MAX_USD,
  SPEND_REPORT_MIN_MS,
} from "./release-defaults.ts";

export type LineState = "normal" | "warn" | "over";

/** One budget against its limit. */
export interface BudgetLine {
  readonly spentUsd: number;
  readonly limitUsd: number;
  /** Spend as a whole percent of the limit, rounded. */
  readonly percent: number;
  readonly line: LineState;
}

export interface BudgetState {
  readonly person: BudgetLine;
  /** The household developer budget: this cell's developer spend plus the other cells'. */
  readonly developer: BudgetLine;
  readonly spend: MonthSpend;
}

/** `warn` from 80% of the limit, `over` from 100%. */
export function lineOf(spentUsd: number, limitUsd: number): LineState {
  if (spentUsd >= limitUsd) return "over";
  if (spentUsd >= (limitUsd * (LIMIT_LINES[0] ?? 80)) / 100) return "warn";
  return "normal";
}

export function budgetLine(spentUsd: number, limitUsd: number): BudgetLine {
  return {
    spentUsd,
    limitUsd,
    percent: limitUsd > 0 ? Math.round((spentUsd / limitUsd) * 100) : 0,
    line: lineOf(spentUsd, limitUsd),
  };
}

/** The person's monthly limit: the owner's setting, or the release default. */
export async function readLimit(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<number> {
  return (await reader.snapshot(LimitsDoc, context))?.limitUsd ?? DEFAULT_PERSON_LIMIT_USD;
}

/** The household settings as last read from the board, with the release defaults. */
export async function householdSettings(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<{ timeZone: string | null; developerLimitUsd: number; othersDeveloperUsd: number }> {
  const cached = await reader.snapshot(HouseholdBudgetDoc, context);
  return {
    timeZone: cached?.timeZone ?? null,
    developerLimitUsd: cached?.developerLimitUsd ?? DEFAULT_DEVELOPER_BUDGET_USD,
    othersDeveloperUsd: cached?.othersDeveloperUsd ?? 0,
  };
}

/** What the limit code needs of a person cell. */
export interface LimitParts {
  readonly person: string;
  readonly harness: Harness;
  readonly now: () => number;
  /** The cell's own time zone (SECBOT_TIME_ZONE or UTC), used until the owner sets one. */
  readonly timeZone: string;
}

/** The month zone of a cell's first month: the household's, else the cell's own. */
async function startZone(parts: LimitParts, context: Context): Promise<string> {
  return (await householdSettings(parts.harness, context)).timeZone ?? parts.timeZone;
}

/** Both budgets of the cell against their limits, from the ledger (rolling the month first). */
export async function budgetState(
  parts: LimitParts,
  context: Context = BACKGROUND_CONTEXT,
): Promise<BudgetState & { readonly rolled: boolean }> {
  const spend = await readMonth(
    parts.harness,
    parts.now(),
    await startZone(parts, context),
    context,
  );
  const household = await householdSettings(parts.harness, context);
  const limit = await readLimit(parts.harness, context);
  return {
    person: budgetLine(spend.person.spentUsd, limit),
    developer: budgetLine(
      spend.developer.spentUsd + household.othersDeveloperUsd,
      household.developerLimitUsd,
    ),
    spend,
    rolled: spend.rolled,
  };
}

/** A dollar amount the owner may set: above 0, at most LIMIT_MAX_USD, at most two decimals. */
export function checkAmount(value: unknown): number {
  const amount = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > LIMIT_MAX_USD ||
    Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6
  ) {
    throw new RefusedChange(
      `a limit is a dollar amount above 0 and at most ${LIMIT_MAX_USD}, with at most two decimals`,
    );
  }
  return Math.round(amount * 100) / 100;
}

/** Sets the person's monthly limit (the owner, through the operator key). One commit. */
export async function setLimit(
  parts: LimitParts,
  value: unknown,
  by: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly limitUsd: number; readonly previousUsd: number }> {
  const limitUsd = checkAmount(value);
  const previousUsd = await parts.harness.commit(async (tx) => {
    const limits = await tx.doc(LimitsDoc);
    const previous = limits.limitUsd ?? DEFAULT_PERSON_LIMIT_USD;
    Object.assign(limits, { limitUsd, setAt: parts.now(), setBy: by });
    return previous;
  }, context);
  logEvent("limit.set", { cell: parts.person, budget: "person", limit_usd: limitUsd, by });
  return { limitUsd, previousUsd };
}

/** One task waiting above a limit, as people see it. */
export interface WaitingItem {
  readonly what: string;
  readonly since: number;
  readonly budget: BudgetName;
}

/** The tasks waiting above a limit, oldest first. */
export async function waitingList(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<WaitingItem[]> {
  const waits = await reader.snapshot(BudgetWaitsDoc, context);
  return Object.values(waits?.tasks ?? {})
    .map(({ what, since, budget }) => ({ what, since, budget }))
    .sort((a, b) => a.since - b.since);
}

/** The notices this device has not seen, oldest first; `mark` moves the device's cursor past them. */
export async function unseenNotices(
  harness: Harness,
  device: string,
  mark: boolean,
  context: Context,
): Promise<LimitNotice[]> {
  const seen = (await harness.snapshot(NoticeDeliveryDoc, context))?.devices[device] ?? 0;
  const notices = ((await harness.snapshot(LimitNoticesDoc, context))?.notices ?? []).filter(
    (notice) => notice.seq > seen,
  );
  const newest = notices.at(-1);
  if (mark && newest !== undefined) await markNoticeSeen(harness, device, newest.seq, context);
  return notices.map((notice) => ({ ...notice }));
}

/** Moves a device's notice cursor to `seq` (never back). */
export async function markNoticeSeen(
  harness: Harness,
  device: string,
  seq: number,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const delivery = await tx.doc(NoticeDeliveryDoc);
    if ((delivery.devices[device] ?? 0) < seq) delivery.devices[device] = seq;
  }, context);
}

const claimKey = (month: string, budget: BudgetName, limitUsd: number, line: number) =>
  `${month}:${budget}:${limitUsd}:${line}`;

export interface LimitWatchOptions extends LimitParts {
  readonly alerts: Alerts;
  /** The household cell; without one the developer budget is counted from this cell alone. */
  readonly household: () => HouseholdClient | undefined;
  /** The guard mode and since when, for the household report. */
  readonly mode: (context: Context) => Promise<{ mode: string; since: number | null }>;
  /** A limit, a household setting, or the month changed: work waiting above a limit checks again. */
  readonly onChange: () => void;
  readonly onReport: (error: unknown) => void;
}

type Pending = { readonly budget: BudgetName; readonly line: number; readonly key: string };

/**
 * Runs one evaluation at a time on a host-side queue (hooks cannot commit), like the model-health
 * monitor; triggers that arrive while one runs fold into the next.
 */
export class LimitWatch {
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  private lastReportAt = 0;
  private lastReportKey = "";

  constructor(private readonly options: LimitWatchOptions) {}

  /** Queues an evaluation; never throws and never blocks the caller. */
  trigger(): void {
    if (this.queued) return;
    this.queued = true;
    this.chain = this.chain
      .then(() => {
        this.queued = false;
        return this.evaluate();
      })
      .catch((error: unknown) => this.options.onReport(error));
  }

  /** Resolves once every queued evaluation ran (tests and shutdown). */
  async settled(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.chain) {
      seen = this.chain;
      await seen;
    }
  }

  private async evaluate(): Promise<void> {
    const { harness, person, now } = this.options;
    const context = BACKGROUND_CONTEXT;
    const state = await budgetState(this.options, context);
    if (state.rolled) this.options.onChange();
    const { spend } = state;
    const conversations = await ledgerConversations(harness, context);
    const household = this.options.household();
    const board = household?.reportSpend !== undefined;
    const at = now();
    const { notices, toSend, developerLines } = await harness.commit(async (tx) => {
      await noteHours(tx, conversations, at);
      const limits = await tx.doc(LimitsDoc);
      const recorded: LimitNotice[] = [];
      const send: Pending[] = [];
      const lines: Pending[] = [];
      for (const budget of ["person", "developer"] as const) {
        const { spentUsd, limitUsd } = state[budget];
        const prefix = `${spend.month}:${budget}:${limitUsd}:`;
        const reached = LIMIT_LINES.filter((line) => spentUsd >= (limitUsd * line) / 100);
        const fresh = reached.filter((line) => !Object.hasOwn(limits.noticed, prefix + line));
        const top = fresh.at(-1);
        for (const line of fresh) {
          limits.noticed[prefix + line] = at;
          // Passing both lines at once notifies only the higher one.
          if (line !== top) limits.alerts[prefix + line] = { claimedAt: at, sentAt: at };
        }
        if (top !== undefined) {
          const doc = await tx.doc(LimitNoticesDoc);
          const notice: LimitNotice = {
            seq: doc.next++,
            at,
            month: spend.month,
            zone: spend.zone,
            budget,
            line: top,
            spentUsd,
            limitUsd,
            resetsAt: spend.resetsAt,
          };
          doc.notices.push(notice);
          recorded.push({ ...notice });
        }
        // Every line reached this month at this limit whose alert is not out yet.
        for (const line of reached) {
          const key = prefix + line;
          const alert = Object.hasOwn(limits.alerts, key) ? limits.alerts[key] : undefined;
          if (alert?.sentAt != null) continue;
          if (alert !== undefined && at - alert.claimedAt <= ALERT_CLAIM_STALE_MS) continue;
          if (budget === "developer" && board) {
            lines.push({ budget, line, key });
            continue;
          }
          limits.alerts[key] = { claimedAt: at, sentAt: null };
          send.push({ budget, line, key });
        }
      }
      return { notices: recorded, toSend: send, developerLines: lines };
    }, context);
    const developer = await this.report(state, developerLines, at, notices.length > 0);
    toSend.push(...developer.yours);
    const sent = new Set<string>();
    for (const pending of toSend) {
      const ok = await this.options.alerts.sendLimit({
        budget: pending.budget,
        line: pending.line,
      });
      if (ok) sent.add(pending.key);
      await harness.commit(async (tx) => {
        const alerts = (await tx.doc(LimitsDoc)).alerts;
        if (ok) alerts[pending.key] = { claimedAt: at, sentAt: now() };
        else delete alerts[pending.key];
      }, context);
      if (pending.budget === "developer" && board) {
        await household
          ?.alertSent?.({
            month: spend.month,
            budget: "developer",
            limitUsd: state.developer.limitUsd,
            line: pending.line,
            cell: person,
            sent: ok,
          })
          .catch((error: unknown) => this.options.onReport(error));
      }
    }
    for (const notice of notices) {
      const key = claimKey(notice.month, notice.budget, notice.limitUsd, notice.line);
      logEvent("limit.crossed", {
        cell: person,
        budget: notice.budget,
        line: notice.line,
        spend_usd: Math.round(notice.spentUsd * 10_000) / 10_000,
        limit_usd: notice.limitUsd,
        alerted: sent.has(key),
      });
    }
  }

  /**
   * Reports this cell's month to the household budget board, when one is reachable: at most every
   * SPEND_REPORT_MIN_MS, at once when a line, a notice, or the developer spend changed or a
   * developer alert waits. Keeps the board's settings and the other cells' developer spend, and
   * returns the developer alerts this cell claimed.
   */
  private async report(
    state: BudgetState,
    developerLines: readonly Pending[],
    at: number,
    noticed: boolean,
  ): Promise<{ yours: Pending[] }> {
    const household = this.options.household();
    if (household?.reportSpend === undefined) return { yours: [] };
    const { spend, person, developer } = state;
    const key = [
      spend.month,
      person.line,
      developer.line,
      spend.developer.spentUsd.toFixed(4),
      person.limitUsd,
    ].join(":");
    const due =
      at - this.lastReportAt >= SPEND_REPORT_MIN_MS ||
      key !== this.lastReportKey ||
      developerLines.length > 0 ||
      noticed;
    if (!due) return { yours: [] };
    const mode = await this.options.mode(BACKGROUND_CONTEXT);
    const report: SpendReport = {
      opId: `spend:${this.options.person}:${spend.month}:${at}`,
      cell: this.options.person,
      month: spend.month,
      timeZone: spend.zone,
      at,
      spentUsd: person.spentUsd,
      limitUsd: person.limitUsd,
      mode: mode.mode,
      modeSince: mode.since,
      byLayer: { ...spend.person.byLayer },
      byRole: { ...spend.person.byRole },
      developerUsd: spend.developer.spentUsd,
      developerLimitUsd: developer.limitUsd,
      developerLines: developerLines.map((pending) => pending.line),
    };
    let answer: Awaited<ReturnType<NonNullable<HouseholdClient["reportSpend"]>>>;
    try {
      answer = await household.reportSpend(report);
    } catch (error) {
      // Logged by the household client (`household.call`); the next evaluation reports again.
      this.options.onReport(error);
      return { yours: [] };
    }
    this.lastReportAt = at;
    this.lastReportKey = key;
    const changed = await this.keepSettings(answer.board.settings, answer.othersDeveloperUsd);
    if (changed) this.options.onChange();
    const yours: Pending[] = [];
    const done: string[] = [];
    for (const { line, status } of answer.alerts) {
      const pending = developerLines.find((each) => each.line === line);
      if (pending === undefined) continue;
      if (status === "yours") yours.push(pending);
      else if (status === "sent") done.push(pending.key);
    }
    if (yours.length + done.length > 0) {
      await this.options.harness.commit(async (tx) => {
        const alerts = (await tx.doc(LimitsDoc)).alerts;
        for (const pending of yours) alerts[pending.key] = { claimedAt: at, sentAt: null };
        for (const each of done) alerts[each] = { claimedAt: at, sentAt: at };
      }, BACKGROUND_CONTEXT);
    }
    if (changed) this.trigger();
    return { yours };
  }

  /**
   * Keeps the board's household settings in the cell. A time zone that differs from the current
   * month's applies from the next month. Returns true when a setting or the others' spend changed.
   */
  async keepSettings(
    settings: { readonly timeZone: string | null; readonly developerLimitUsd: number | null },
    othersDeveloperUsd?: number,
  ): Promise<boolean> {
    return this.options.harness.commit(async (tx) => {
      const cached = await tx.doc(HouseholdBudgetDoc);
      const ledger = await tx.doc(MonthLedgerDoc);
      const changed =
        cached.timeZone !== settings.timeZone ||
        cached.developerLimitUsd !== settings.developerLimitUsd ||
        (othersDeveloperUsd !== undefined &&
          Math.abs(cached.othersDeveloperUsd - othersDeveloperUsd) > 1e-9);
      cached.timeZone = settings.timeZone;
      cached.developerLimitUsd = settings.developerLimitUsd;
      if (othersDeveloperUsd !== undefined) cached.othersDeveloperUsd = othersDeveloperUsd;
      cached.month = ledger.month;
      cached.readAt = this.options.now();
      if (ledger.month !== "" && settings.timeZone !== null && settings.timeZone !== ledger.zone) {
        ledger.nextZone = settings.timeZone;
      } else if (ledger.month !== "" && settings.timeZone === ledger.zone) {
        ledger.nextZone = null;
      }
      return changed;
    }, BACKGROUND_CONTEXT);
  }
}

/** The usage line of a chat session: month-to-date spend against the limit, and the mode. */
export interface UsageLine {
  readonly month: string;
  readonly zone: string;
  readonly resetsAt: number;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly line: LineState;
  readonly mode: string;
}

/** `GET /v1/cells/{p}/cost` and `GET /ops/cost?cell=`: the person's month, for the CLI and the app. */
export interface CostView {
  readonly person: string;
  readonly month: string;
  readonly timeZone: string;
  readonly resetsAt: number;
  readonly mode: string;
  readonly modeSince: number | null;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly line: LineState;
  readonly byLayer: {
    readonly agent: number;
    readonly decision: number;
    readonly reviewer: number;
  };
  readonly byRole: Readonly<Record<string, number>>;
  readonly hours: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly waiting: readonly WaitingItem[];
  readonly developer: BudgetLine;
}

/** The cost view of a budget state. */
export function costViewOf(
  person: string,
  state: BudgetState,
  mode: { readonly mode: string; readonly since: number | null },
  waiting: readonly WaitingItem[],
): CostView {
  const { spend } = state;
  return {
    person,
    month: spend.month,
    timeZone: spend.zone,
    resetsAt: spend.resetsAt,
    mode: mode.mode,
    modeSince: mode.since,
    spentUsd: state.person.spentUsd,
    limitUsd: state.person.limitUsd,
    percent: state.person.percent,
    line: state.person.line,
    byLayer: { ...spend.person.byLayer },
    byRole: { ...spend.person.byRole },
    hours: spend.hours,
    waiting,
    developer: state.developer,
  };
}
