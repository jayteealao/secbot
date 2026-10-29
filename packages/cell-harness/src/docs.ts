/**
 * The cell's own session documents, committed with the transcript (pi-durable `defineDoc`,
 * scope "session": one per harness, which is one per person cell).
 */
import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type EntryId,
  type JsonObject,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ActivityRecord } from "./activity.ts";
import type { HeldCall } from "./approvals.ts";
import type { SharedOp } from "./household-contract.ts";
import {
  DEFAULT_DECISION_ADAPTER,
  type DecisionAdapter,
  type JobEffort,
  type OutsideKind,
  type Tier,
} from "./release-defaults.ts";
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
 * `secbot.jobs`: kept for hand-offs in flight when a cell upgrades to the job board, so a reporter
 * started by the retired hand-off tool still finishes once with its cost. The cost marks of hand-off jobs. `starts` is the specialist conversation's ledger
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

export type JobPriority = "urgent" | "deadline" | "routine" | "research";
/**
 * A job's status. `paused` waits for the lead's escalation move (cap or loop guard); `waiting`
 * waits for an answer to its question; `rejected` is a risky result the reviewer turned down;
 * `blocked` is a job the content check stopped (outside content tried to give its agent orders, or
 * the check could not answer).
 */
export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting"
  | "done"
  | "failed"
  | "rejected"
  | "stopped"
  | "blocked";
/** What a waiting result is: the inbox wakes the lead at once for every kind but `routine`. */
export type ResultKind = "failure" | "question" | "risky" | "routine";

/** A job's result on the board, until and after the lead pulls it. */
export type JobResult = {
  kind: ResultKind;
  text: string;
  at: number;
  /** When the lead pulled it with `job_result`; null while it waits. */
  pulledAt: number | null;
  /** When a wake notice for it went to the lead; null when none did. */
  wokeAt: number | null;
};

/** Why a job paused before its next model step, when, and the numbers behind it. */
export type JobPause = { reason: "cap" | "loop"; at: number; detail: string };

/**
 * A job's open or last question: one the job asked the lead (`job`), or the escalation question to
 * the person after the job used its raise and its restart (`escalation`). The first answer wins.
 */
export type JobQuestion = {
  /** Counts the job's questions, from 1. */
  number: number;
  from: "job" | "escalation";
  text: string;
  askedAt: number;
  /** The lead handed it to the person (`ask_person`), or code did for an escalation. */
  toPerson: boolean;
  personAskedAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  answeredBy: "lead" | "person" | null;
};

/** One earlier run of a job, kept when the lead restarted it. */
export type JobRun = {
  conversationId: ConversationId | null;
  taskId: TaskId | null;
  startedAt: number;
  endedAt: number;
  /** The lead's failure note for the run after it. */
  note: string;
};

/** The second-model review of a risky result. */
export type JobReview = {
  status: "running" | "passed" | "rejected";
  model: string;
  reason: string;
  conversationId: ConversationId | null;
  at: number;
};

/** The outside content a job has read: when first, which kinds, and through which tools. */
export type JobOutside = { at: number; kinds: OutsideKind[]; tools: string[] };

/**
 * Why the content check stopped a job: it found orders to the agent (`hit`), it timed out, or it
 * failed; the kind of content, the reading tool, the chunk (when one chunk answered), and when.
 */
export type JobBlock = {
  cause: "hit" | "timeout" | "error";
  kind: OutsideKind;
  tool: string;
  chunk: number | null;
  at: number;
};

/** The fields added to rows after version 1, empty (a new row, and a row of an older board). */
export const emptyJobExtras = (): Pick<
  JobRow,
  | "pause"
  | "question"
  | "risky"
  | "toolsUsed"
  | "runs"
  | "review"
  | "requestedBy"
  | "resumedAt"
  | "outside"
  | "block"
  | "stop"
  | "resumes"
  | "shared"
> => ({
  pause: null,
  question: null,
  risky: { code: [], lead: null },
  toolsUsed: [],
  runs: [],
  review: null,
  requestedBy: null,
  resumedAt: null,
  outside: null,
  block: null,
  stop: null,
  resumes: 0,
  shared: null,
});

/**
 * A person-side row's link to a shared job that runs in the household: the household's number
 * (null until the household took the proposal), this person's part, the other person, where the
 * consent stands, who pays, the operations not yet delivered, and the charges already booked.
 */
export type SharedLink = {
  household: number | null;
  role: "requester" | "other";
  /** The other person's cell name. */
  with: string;
  consent: "asking" | "asked" | "offered" | "shown" | "joined" | "declined";
  payer: "half" | "you" | "them";
  estimateUsd: number;
  /** Operations for the household, oldest first; each leaves when the household acks it. */
  outbox: SharedOp[];
  /** The ids of the household's charges already booked on this row's ledger conversation. */
  charges: string[];
  /** When the household's result copied onto this row was written; null until one is. */
  resultAt: number | null;
  /** The household holds the job until a payer has budget again. */
  waitingBudget: boolean;
  /**
   * Notices for the lead about this job that were not delivered yet (each leaves when it is), so
   * a cell that restarts before a delivery sends it on its next exchange. Absent on older rows.
   */
  unsent?: { job: number; text: string; requestId: string; ungated?: boolean }[];
};

/** One job on the board. Numbers grow per cell and are never reused. */
export type JobRow = {
  number: number;
  title: string;
  brief: string;
  priority: JobPriority;
  /** An ISO date (`YYYY-MM-DD`) the lead read from the request, or null. */
  deadline: string | null;
  template: string;
  tier: Tier;
  /** The effort the lead asked for, and the one the tier's model applies after clamping. */
  effort: { requested: JobEffort; applied: string };
  attempts: { raises: number; restarts: number };
  /** The job conversation's spend so far, in USD. */
  cost: number;
  /** The per-job cap of the job's current tier, in USD. */
  cap: number;
  status: JobStatus;
  /** The person the job works for. */
  owner: string;
  conversationId: ConversationId | null;
  taskId: TaskId | null;
  /** The lead run's first input when the job started, or null when the lead was not busy. */
  turn: number | null;
  createdAt: number;
  endedAt: number | null;
  result: JobResult | null;
  /** Why the job is paused; null while it is not. */
  pause: JobPause | null;
  question: JobQuestion | null;
  /** Why the result is risky: code's reasons (tools, template) and the lead's reason, if any. */
  risky: { code: string[]; lead: string | null };
  /** The tools the current run called, by name, in first-use order. */
  toolsUsed: string[];
  /** Every earlier run of the job, oldest first. */
  runs: JobRun[];
  review: JobReview | null;
  /** The job that asked the lead for this one (`request_job`), or null. */
  requestedBy: number | null;
  /**
   * When the lead last resumed the paused job (wall clock, as message timestamps): the loop guard
   * counts only failing steps after it. Null when never resumed.
   */
  resumedAt: number | null;
  /**
   * The outside content the job has read (web pages, mails, files), or null. Kept across restarts:
   * an outside action of the job needs the reviewer's yes.
   */
  outside: JobOutside | null;
  /** Why the content check stopped the job; null unless it is `blocked`. */
  block: JobBlock | null;
  /** Who stopped the job and when (the person's or the owner's stop); null unless it is `stopped`. */
  stop: JobStop | null;
  /** How often the person resumed the job after a stop or a block; never counted as a restart. */
  resumes: number;
  /** The link to the household's job when this job is shared by both people; null otherwise. */
  shared: SharedLink | null;
};

/** Who stopped a job with the stop command, and when. */
export type JobStop = { at: number; by: "person" | "owner" };

/** Statuses of a job that no longer runs. */
export const ENDED: ReadonlySet<JobStatus> = new Set(["done", "failed", "stopped", "blocked"]);

/**
 * A job's place in the priority order: urgent first, then deadlines by date, then routine, then
 * research. Two keys compare by rank, then by date.
 */
export function priorityKey(row: Pick<JobRow, "priority" | "deadline">): [number, string] {
  switch (row.priority) {
    case "urgent":
      return [0, ""];
    case "deadline":
      return [1, row.deadline ?? "9999-12-31"];
    case "routine":
      return [2, ""];
    default:
      return [3, ""];
  }
}

/** Compares two priority keys: negative when `a` comes first. */
export function compareKeys(a: [number, string], b: [number, string]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

type Board = {
  nextNumber: number;
  jobs: Record<string, JobRow>;
  byConversation: Record<string, number>;
  /** The live jobs' numbers in the order they run and show: the person can change it. */
  queue: number[];
};

/**
 * `secbot.job-board`: every job of this person, keyed by its number as text, and each job
 * conversation's number (`roleOf` and the ledger find a job from its conversation in one read).
 */
export const JobBoardDoc = defineDoc<Board>({
  kind: "secbot.job-board",
  version: 5,
  scope: "session",
  initial: () => ({ nextNumber: 1, jobs: {}, byConversation: {}, queue: [] }),
  migrate: (value) => migrateJobBoard(value),
});

/**
 * A board of an earlier version: every row gains this version's fields, empty, and the queue lists
 * the live jobs by priority (older first within one priority).
 */
export function migrateJobBoard(value: JsonObject): Board {
  const old = value as unknown as {
    nextNumber: number;
    jobs: Record<string, Partial<JobRow>>;
    byConversation: Record<string, number>;
    queue?: number[];
  };
  const jobs: Record<string, JobRow> = {};
  for (const [key, row] of Object.entries(old.jobs ?? {})) {
    jobs[key] = { ...emptyJobExtras(), ...row } as JobRow;
  }
  const queue =
    old.queue ??
    Object.values(jobs)
      .filter((row) => !ENDED.has(row.status))
      .sort((a, b) => compareKeys(priorityKey(a), priorityKey(b)) || a.number - b.number)
      .map((row) => row.number);
  return {
    nextNumber: old.nextNumber ?? 1,
    jobs,
    byConversation: old.byConversation ?? {},
    queue,
  };
}

/** A lead tool call that runs in the background, and what it stored. */
export type Receipt = {
  number: number;
  tool: string;
  turn: number | null;
  status: "running" | "done" | "interrupted";
  /** The tool's answer once done; empty while running. */
  text: string;
  isError: boolean;
  /** A secret's value: never listed by any view. */
  sensitive: boolean;
  at: number;
  /** When the lead read it with `read_result`; null while unread. */
  readAt: number | null;
};

/** `secbot.receipt`: one background call of the lead, keyed `r<n>`. */
export const ReceiptDoc = defineDocFamily<{ receipt: Receipt | null }, null>({
  kind: "secbot.receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ receipt: null }),
});

/** `secbot.receipts`: the next receipt number and the receipts not read yet, oldest first. */
export const ReceiptsDoc = defineDoc<{ nextNumber: number; open: string[] }>({
  kind: "secbot.receipts",
  version: 1,
  scope: "session",
  initial: () => ({ nextNumber: 1, open: [] }),
});

/** Where the lead was when the person interrupted it. */
export type Bookmark = {
  turn: number;
  at: number;
  /** Receipts of that turn still running or unread. */
  receipts: string[];
  /** Jobs started in that turn whose results were not pulled. */
  jobIds: number[];
  /** The lead's one sentence on what it was doing; null until it adds one. */
  note: string | null;
};

/** `secbot.bookmark`: the interrupt bookmark, until the lead resumes with `resume_work`. */
export const BookmarkDoc = defineDoc<{ bookmark: Bookmark | null }>({
  kind: "secbot.bookmark",
  version: 1,
  scope: "session",
  initial: () => ({ bookmark: null }),
});

/** `secbot.templates`: the owner's custom job templates, by name. */
export const TemplatesDoc = defineDoc<{
  custom: Record<string, { instruction: string; tier: Tier }>;
}>({
  kind: "secbot.templates",
  version: 1,
  scope: "session",
  initial: () => ({ custom: {} }),
});

/** `secbot.tier-settings`: the owner's per-job cap of each tier, in USD (release caps elsewhere). */
export const TierSettingsDoc = defineDoc<{ caps: Record<string, number> }>({
  kind: "secbot.tier-settings",
  version: 1,
  scope: "session",
  initial: () => ({ caps: {} }),
});

/**
 * `secbot.stop`: the stop command. `active` is set while a stop runs: no job starts, restarts, or
 * resumes then. `last` is the newest finished stop and what it stopped.
 */
export const StopDoc = defineDoc<{
  active: JobStop | null;
  last: { at: number; by: JobStop["by"]; jobs: number; turn: boolean } | null;
}>({
  kind: "secbot.stop",
  version: 1,
  scope: "session",
  initial: () => ({ active: null, last: null }),
});

/**
 * `secbot.handoff-note`: the lead's hand-off note, written before its last compaction: the text,
 * when, the first entry the compaction kept, and how many compactions wrote a note.
 */
export const HandoffNoteDoc = defineDoc<{
  note: { text: string; at: number; firstKept: string; compactions: number } | null;
}>({
  kind: "secbot.handoff-note",
  version: 1,
  scope: "session",
  initial: () => ({ note: null }),
});

/** The capacity document's fields. */
export type Capacity = {
  /** How many jobs this cell was measured to run at once (the owner's setting); null when unset. */
  measured: number | null;
  /** When it was measured (epoch ms); null when unset. */
  at: number | null;
  /** When the owner was last alerted that running jobs passed the number; null before any alert. */
  alertedAt: number | null;
  /** True while running jobs are above the number (one alert per such episode). */
  passing: boolean;
};

/**
 * `secbot.capacity`: how many jobs this cell was measured to run at once, and when (null until the
 * owner sets it; the release default applies then), and the warning's memory: the last alert and
 * whether running jobs are above the number now. More running jobs only warn: nothing is held back.
 */
export const CapacityDoc = defineDoc<Capacity>({
  kind: "secbot.capacity",
  version: 2,
  scope: "session",
  initial: () => ({ measured: null, at: null, alertedAt: null, passing: false }),
  migrate: (value) => migrateCapacity(value),
});

/** A version-1 capacity document: its number and date, no alert yet, and no episode open. */
export function migrateCapacity(value: JsonObject): Capacity {
  const old = value as Partial<Capacity>;
  return {
    measured: old.measured ?? null,
    at: old.at ?? null,
    alertedAt: old.alertedAt ?? null,
    passing: old.passing ?? false,
  };
}
