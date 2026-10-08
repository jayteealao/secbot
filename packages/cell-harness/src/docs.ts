/**
 * The cell's own session documents, committed with the transcript (pi-durable `defineDoc`,
 * scope "session": one per harness, which is one per person cell).
 */
import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type EntryId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ActivityRecord } from "./activity.ts";
import type { HeldCall } from "./approvals.ts";
import { DEFAULT_DECISION_ADAPTER, type DecisionAdapter } from "./release-defaults.ts";
import type { Rule } from "./rules.ts";

export type SpecialistRecord = {
  conversationId: ConversationId;
  instruction: string;
  /** The background anchor task that owns the specialist's conversation. */
  anchorTaskId: TaskId;
  builtIn: boolean;
  /** Answers already reported to the lead, so a restart reports each once. */
  reported: EntryId[];
};

/** `secbot.specialists`: the roster, keyed by specialist name. */
export const RosterDoc = defineDoc<{
  specialists: Record<string, SpecialistRecord>;
  /** Hand-off reporter tasks, keyed by the handoff tool task that created them. */
  reporters: Record<string, TaskId>;
}>({
  kind: "secbot.specialists",
  version: 1,
  scope: "session",
  initial: () => ({ specialists: {}, reporters: {} }),
});

/** `secbot.role-models`: the owner's changes to the role-to-model map; release defaults fill the rest. */
export const RoleModelsDoc = defineDoc<{ overrides: Record<string, string> }>({
  kind: "secbot.role-models",
  version: 1,
  scope: "session",
  initial: () => ({ overrides: {} }),
});

export type ModelHealthState = "ok" | "failing" | "credit";

/** `secbot.model-health`: whether model calls are failing, since when, and whether the owner was told. */
export const ModelHealthDoc = defineDoc<{
  state: ModelHealthState;
  since: number | null;
  lastError: string;
  alertedAt: number | null;
  /** Which alert `alertedAt` claimed; absent in documents written before it existed. */
  alertedKind?: "outage" | "credit" | null;
  /** When that alert was sent; null while the send is pending (a crash then leaves it unsent). */
  sentAt?: number | null;
  /** Sessions show "waiting for the model" while this is true. */
  waiting: boolean;
}>({
  kind: "secbot.model-health",
  version: 1,
  scope: "session",
  initial: () => ({ state: "ok", since: null, lastError: "", alertedAt: null, waiting: false }),
});

/** `secbot.delivery`: per device, the newest lead message a session or `missed` delivered. */
export const DeliveryDoc = defineDoc<{ devices: Record<string, EntryId> }>({
  kind: "secbot.delivery",
  version: 1,
  scope: "session",
  initial: () => ({ devices: {} }),
});

/**
 * `secbot.rules`: the owner's rules and the person's rules for this person's agents. Seeded once
 * with the release owner rule and the four default person rules (`seeded`).
 */
export const RulesDoc = defineDoc<{
  seeded: boolean;
  nextId: number;
  owner: Rule[];
  person: Rule[];
}>({
  kind: "secbot.rules",
  version: 1,
  scope: "session",
  initial: () => ({ seeded: false, nextId: 1, owner: [], person: [] }),
});

/**
 * `secbot.activity`: per month (`YYYY-MM` in the cell's time zone) the number of pages and
 * records, and the keys of the newest records, so a guard that runs again after a crash finds
 * its record and writes no second one.
 */
export const ActivityDoc = defineDoc<{
  months: Record<string, { pages: number; total: number }>;
  recent: string[];
}>({
  kind: "secbot.activity",
  version: 1,
  scope: "session",
  initial: () => ({ months: {}, recent: [] }),
});

/** `secbot.activity-page`: up to ACTIVITY_PAGE_SIZE records, keyed `YYYY-MM:<page>` (from 1). */
export const ActivityPageDoc = defineDocFamily<{ records: ActivityRecord[] }, null>({
  kind: "secbot.activity-page",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ records: [] }),
});

/**
 * `secbot.approvals`: the next held-call number (numbers grow per cell and are never reused, so a
 * late answer reaches the call it names) and the numbers still waiting for an answer, oldest first.
 */
export const ApprovalsDoc = defineDoc<{ nextNumber: number; pending: number[] }>({
  kind: "secbot.approvals",
  version: 1,
  scope: "session",
  initial: () => ({ nextNumber: 1, pending: [] }),
});

export type GuardMode = "shadow" | "enforce";

/**
 * `secbot.guard-mode`: whether the model layers (the decision model and the reviewer) enforce. In
 * shadow mode they record what they would do and the call runs; rules, ask-first holds, and their
 * approvals enforce in both modes. Every cell starts in shadow; `since` is when the current mode
 * began (set at the first open for a cell that never switched).
 */
export const GuardModeDoc = defineDoc<{
  mode: GuardMode;
  since: number | null;
  switchedBy: string | null;
}>({
  kind: "secbot.guard-mode",
  version: 1,
  scope: "session",
  initial: () => ({ mode: "shadow", since: null, switchedBy: null }),
});

/** `secbot.decision-model`: the decision model's adapter; the owner switches it. */
export const DecisionModelDoc = defineDoc<{ adapter: DecisionAdapter }>({
  kind: "secbot.decision-model",
  version: 1,
  scope: "session",
  initial: () => ({ adapter: DEFAULT_DECISION_ADAPTER }),
});

/** `secbot.approval`: one held call, keyed by its number as text. Records are never pruned. */
export const ApprovalDoc = defineDocFamily<{ call: HeldCall | null }, null>({
  kind: "secbot.approval",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ call: null }),
});

/**
 * `secbot.approval-key`: the held-call numbers of one request id, oldest first. A hook that runs
 * again (after a crash, or a retry under the same request id) finds its record here.
 */
export const ApprovalKeyDoc = defineDocFamily<{ numbers: number[] }, null>({
  kind: "secbot.approval-key",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ numbers: [] }),
});

/**
 * `secbot.month-ledger`: the current month of the cell's spend. `pi.usage` holds totals that only
 * grow, so a month is the current total less `baseline`: the cost of every bucket key of every
 * conversation when the month began (`m:<provider/model>` or `t:<tool>`). A conversation with no
 * baseline counts whole. `hours` is the month's spend by local hour and role (the app's heat
 * chart), `seen` each conversation's total the hour chart last counted. `nextZone` is a household
 * time zone that applies from the next month. `closed` keeps each ended month's person spend, taken
 * at the roll (absent in documents written before it existed).
 */
export const MonthLedgerDoc = defineDoc<{
  month: string;
  zone: string;
  startsAt: number;
  endsAt: number;
  nextZone: string | null;
  baseline: Record<string, Record<string, number>>;
  hours: Record<string, Record<string, number>>;
  seen: Record<string, number>;
  closed?: Record<string, number>;
}>({
  kind: "secbot.month-ledger",
  version: 1,
  scope: "session",
  initial: () => ({
    month: "",
    zone: "UTC",
    startsAt: 0,
    endsAt: 0,
    nextZone: null,
    baseline: {},
    hours: {},
    seen: {},
  }),
});

/** One owner alert of a limit line: claimed before the send, then sent (or released on failure). */
export type LimitAlert = { claimedAt: number; sentAt: number | null };

/**
 * `secbot.limits`: this person's monthly limit (null: the release default), who set it, and the
 * limit lines already reached, keyed `<month>:<budget>:<limit>:<line>`: `noticed` once per line
 * (its notice and `limit.crossed`), `alerts` the owner alert of that line.
 */
export const LimitsDoc = defineDoc<{
  limitUsd: number | null;
  setAt: number | null;
  setBy: string | null;
  noticed: Record<string, number>;
  alerts: Record<string, LimitAlert>;
}>({
  kind: "secbot.limits",
  version: 1,
  scope: "session",
  initial: () => ({ limitUsd: null, setAt: null, setBy: null, noticed: {}, alerts: {} }),
});

export type BudgetName = "person" | "developer";

/** `secbot.budget-waits`: the tasks waiting above a limit, by task id (what, and since when). */
export const BudgetWaitsDoc = defineDoc<{
  tasks: Record<string, { budget: BudgetName; what: string; since: number }>;
}>({
  kind: "secbot.budget-waits",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: {} }),
});

/**
 * `secbot.jobs`: the cost marks of hand-off jobs. `starts` is the specialist conversation's ledger
 * total when a job's brief was delivered, `ends` a finished job's cost until its done record is
 * written (both by reporter task id), and `high` each specialist's total when its last job ended.
 */
export const JobsDoc = defineDoc<{
  starts: Record<string, number>;
  ends: Record<string, number>;
  high: Record<string, number>;
}>({
  kind: "secbot.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ starts: {}, ends: {}, high: {} }),
});

/** One limit notice: a line of a budget reached in a month. */
export type LimitNotice = {
  seq: number;
  at: number;
  month: string;
  zone: string;
  budget: BudgetName;
  line: number;
  spentUsd: number;
  limitUsd: number;
  resetsAt: number;
};

/** `secbot.limit-notices`: every limit notice, oldest first; `next` is the next sequence number. */
export const LimitNoticesDoc = defineDoc<{ next: number; notices: LimitNotice[] }>({
  kind: "secbot.limit-notices",
  version: 1,
  scope: "session",
  initial: () => ({ next: 1, notices: [] }),
});

/** `secbot.notice-delivery`: per device, the newest notice a session or `missed` showed. */
export const NoticeDeliveryDoc = defineDoc<{ devices: Record<string, number> }>({
  kind: "secbot.notice-delivery",
  version: 1,
  scope: "session",
  initial: () => ({ devices: {} }),
});

/**
 * `secbot.household-budget`: the household settings and the other cells' developer spend, as the
 * household budget board last gave them (null: not read yet, so the release defaults apply).
 */
export const HouseholdBudgetDoc = defineDoc<{
  timeZone: string | null;
  developerLimitUsd: number | null;
  othersDeveloperUsd: number;
  month: string;
  readAt: number | null;
}>({
  kind: "secbot.household-budget",
  version: 1,
  scope: "session",
  initial: () => ({
    timeZone: null,
    developerLimitUsd: null,
    othersDeveloperUsd: 0,
    month: "",
    readAt: null,
  }),
});
