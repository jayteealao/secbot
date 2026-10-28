/**
 * The person's view of their job board, built in the cell from the committed board: live jobs in
 * queue order, then jobs that ended in the last 24 hours. Each row carries its reason line as
 * text, so the command line and the app print one wording; they only lay the view out.
 */
import type { GuardMode, JobRow } from "./docs.ts";
import {
  type BoardState,
  blockReason,
  ENDED,
  EXHAUSTED,
  openQuestion,
  queueOf,
} from "./job-board.ts";
import type { JobTemplate } from "./release-defaults.ts";

/** How far back the board lists jobs that ended: 24 hours. */
export const FINISHED_WINDOW_MS = 24 * 60 * 60_000;

/** A row's reason line: what code it has, and the text the person reads. */
export type BoardReason = { readonly code: string; readonly text: string };

export type BoardRow = {
  readonly number: number;
  readonly title: string;
  /** `urgent`, `due <d Mon>`, `routine`, or `research`. */
  readonly priority: string;
  readonly tier: string;
  /** The effort the model applied: `low`, `med`, `high`, or the model's own word. */
  readonly effort: string;
  /** Raises and restarts used, as `<raises>+<restarts>`. */
  readonly try: string;
  readonly cost: number;
  readonly cap: number;
  readonly status: string;
  readonly reason: BoardReason | null;
  /** A shared job's line (who it is shared with and who pays); absent for the person's own job. */
  readonly shared?: string;
};

export type BoardView = {
  readonly person: string;
  readonly mode: GuardMode;
  /** Jobs that started and have not finished (a queued job is listed, not counted). */
  readonly live: number;
  /** Results the lead has not read yet. */
  readonly waiting: number;
  readonly rows: readonly BoardRow[];
  readonly finished: readonly BoardRow[];
  readonly shown: number;
  /** Present only when more jobs run at once than the cell was measured at. */
  readonly capacity: {
    readonly jobsAtOnce: number;
    readonly measured: number;
    readonly at: number;
    /** The measurement's date as `d Mon`. */
    readonly on: string;
  } | null;
  readonly templates: readonly { readonly name: string; readonly tier: string }[];
};

export interface BoardViewInput {
  readonly person: string;
  readonly board: BoardState;
  /** The job numbers that wait above a monthly limit (`budgetJobs`). */
  readonly budgetJobs: ReadonlySet<number>;
  readonly mode: GuardMode;
  readonly capacity: { readonly measured: number | null; readonly at: number | null };
  readonly templates: readonly JobTemplate[];
  /** Results the lead has not read yet (`waitingCounts`, every kind). */
  readonly waiting: number;
  /** When the person's month resets: a job waiting above the limit waits until then. */
  readonly resetsAt: number;
  readonly now: number;
  readonly timeZone: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO date (`YYYY-MM-DD`) as `d Mon`, for example `13 Oct`. */
export function dayMonth(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1] ?? "?"}`;
}

const zoned = (at: number, timeZone: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(at);

/** A time of day as `hh:mm` in the person's time zone. */
export const clockOf = (at: number, timeZone: string): string =>
  zoned(at, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A moment's date as `d Mon` in the person's time zone. */
export const dateOf = (at: number, timeZone: string): string =>
  zoned(at, timeZone, { day: "numeric", month: "short" });

const EFFORT_WORDS: Readonly<Record<string, string>> = { medium: "med" };

/**
 * The job numbers waiting above a monthly limit: a wait listed for the job's task, or for one of
 * its model requests (`job <n> …`). Only live jobs wait; an ended job's wake wait is not the job's.
 */
export function budgetJobs(
  board: BoardState,
  waits: Readonly<Record<string, { readonly what: string }>>,
): Set<number> {
  const jobs = new Set<number>();
  const live = queueOf(board);
  for (const [taskId, wait] of Object.entries(waits)) {
    const named = /^job (\d+) /.exec(wait.what)?.[1];
    for (const row of live) {
      if (String(row.taskId) === taskId || (named !== undefined && Number(named) === row.number)) {
        jobs.add(row.number);
      }
    }
  }
  return jobs;
}

/**
 * The status the person sees and its reason line: a running job held above a monthly limit shows
 * `waiting`. Queued, running, and done rows have no reason.
 */
export function reasonOf(
  row: JobRow,
  input: Pick<BoardViewInput, "budgetJobs" | "resetsAt" | "timeZone">,
): { status: string; reason: BoardReason | null } {
  const question = openQuestion(row);
  switch (row.status) {
    case "paused":
      return {
        status: "paused",
        reason:
          row.pause?.reason === "loop"
            ? { code: "loop", text: "same step failed 3 times; the lead decides what next" }
            : { code: "cap", text: "cap reached; the lead asks you before going on" },
      };
    case "failed": {
      const text = row.result?.text ?? EXHAUSTED;
      return {
        status: "failed",
        reason:
          text === EXHAUSTED
            ? { code: "exhausted", text: "raise and restart used; the lead asked you" }
            : { code: "failure", text },
      };
    }
    case "stopped": {
      const at = clockOf(row.stop?.at ?? row.endedAt ?? 0, input.timeZone);
      const by = row.stop?.by === "owner" ? "the owner" : "you";
      return {
        status: "stopped",
        reason: {
          code: row.stop?.by === "owner" ? "stopped-owner" : "stopped",
          text: `stopped by ${by} at ${at}; secbot jobs restart ${row.number}`,
        },
      };
    }
    case "rejected":
      return {
        status: "rejected",
        reason: { code: "rejected", text: `review rejected: ${row.review?.reason ?? ""}` },
      };
    case "blocked":
      return {
        status: "blocked",
        reason:
          row.block === null
            ? { code: "blocked", text: "the content check did not answer; stopped to be safe" }
            : { code: `blocked-${row.block.cause}`, text: blockReason(row.block) },
      };
    default:
      break;
  }
  if (question !== null && !ENDED.has(row.status)) {
    return {
      status: "waiting",
      reason: question.toPerson
        ? {
            code: "question-person",
            text: `asks you: "${question.text}"  /answer ${row.number} <text>`,
          }
        : { code: "question-lead", text: `asks the lead: "${question.text}"` },
    };
  }
  if (input.budgetJobs.has(row.number) && !ENDED.has(row.status)) {
    return {
      status: "waiting",
      reason: {
        code: "budget",
        text: `over your monthly limit; waits for the owner or ${dateOf(input.resetsAt, input.timeZone)}`,
      },
    };
  }
  // A job whose risky result is under review shows running: the review is its last step.
  return { status: row.review?.status === "running" ? "running" : row.status, reason: null };
}

function boardRow(row: JobRow, input: BoardViewInput): BoardRow {
  const { status, reason } = reasonOf(row, input);
  return {
    number: row.number,
    title: row.title,
    priority:
      row.priority === "deadline" && row.deadline !== null
        ? `due ${dayMonth(row.deadline)}`
        : row.priority === "deadline"
          ? "routine"
          : row.priority,
    tier: row.tier,
    effort: EFFORT_WORDS[row.effort.applied] ?? row.effort.applied,
    try: `${row.attempts.raises}+${row.attempts.restarts}`,
    cost: row.cost,
    cap: row.cap,
    status,
    reason,
  };
}

/** The person's board view at `now`. */
export function boardView(input: BoardViewInput): BoardView {
  const { board, now } = input;
  const reviewing = Object.values(board.jobs)
    .filter((row) => ENDED.has(row.status) && row.review?.status === "running")
    .sort((a, b) => a.number - b.number);
  const rows = [...queueOf(board), ...reviewing].map((row) => boardRow(row, input));
  const listed = new Set(rows.map((row) => row.number));
  const finished = Object.values(board.jobs)
    .filter(
      (row) =>
        ENDED.has(row.status) &&
        !listed.has(row.number) &&
        row.endedAt !== null &&
        now - row.endedAt < FINISHED_WINDOW_MS,
    )
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.number - a.number)
    .map((row) => boardRow(row, input));
  const running = rows.filter((row) => row.status === "running").length;
  const { measured, at } = input.capacity;
  return {
    person: input.person,
    mode: input.mode,
    live: rows.filter((row) => row.status !== "queued").length,
    waiting: input.waiting,
    rows,
    finished,
    shown: rows.length + finished.length,
    capacity:
      measured !== null && at !== null && running > measured
        ? { jobsAtOnce: running, measured, at, on: dateOf(at, input.timeZone) }
        : null,
    templates: input.templates.map((template) => ({ name: template.name, tier: template.tier })),
  };
}
