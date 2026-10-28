/**
 * The lead's prompt sections: the interrupt bookmark (first, only while one exists), the current
 * time, and the job board. Sections render before each request from committed documents
 * (pi-durable README "System Prompt"), so a job result or a template the owner adds is in the
 * lead's next request, and only a changed section is sent again. The time is given to the minute,
 * so it changes at most once a minute.
 */
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { bookmarkText } from "./bookmark.ts";
import {
  type Bookmark,
  BookmarkDoc,
  JobBoardDoc,
  type JobRow,
  type Receipt,
  TemplatesDoc,
} from "./docs.ts";
import {
  type BoardState,
  blockReason,
  ENDED,
  liveRows,
  openQuestion,
  restCount,
  waitingCounts,
} from "./job-board.ts";
import { openReceipts } from "./receipts.ts";
import { ESCALATION_LIMITS, type JobTemplate, LOOP_LIMIT } from "./release-defaults.ts";
import { localTime } from "./reminder.ts";
import { templatesOf } from "./templates.ts";

export interface TimeEnv {
  /** The person's time zone (IANA, for example Europe/London); UTC when unset. */
  readonly SECBOT_TIME_ZONE?: string;
}

/** The zone the lead states times in: the configured one when the runtime knows it, else UTC. */
export function timeZoneOf(env: TimeEnv): string {
  const zone = env.SECBOT_TIME_ZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** The time section's text at `now`. */
export function timeSection(now: number, timeZone: string): string {
  const minute = Math.floor(now / 60_000) * 60_000;
  return [
    `Now: ${new Date(minute).toISOString().slice(0, 16)}Z (UTC); ${localTime(minute, timeZone)} in ${timeZone}, the person's time zone.`,
    "Read times the person gives in their time zone unless they name another one.",
  ].join("\n");
}

/** The bookmark section: the bookmark and how to resume; undefined when there is none. */
export function bookmarkSection(bookmark: Bookmark | null): string | undefined {
  if (bookmark === null) return undefined;
  return `${bookmarkText(bookmark)}\nAnswer the person first; call resume_work when you are back on it.`;
}

/**
 * What a job's line adds after its title: why it is paused, its open question, its review, who
 * asked for it, and the escalations it used. Empty for a plain running job.
 */
export function jobStateDetails(row: JobRow): string {
  const details: string[] = [];
  if (row.status === "paused" && row.pause !== null) {
    details.push(
      row.pause.reason === "cap"
        ? `paused: cap $${row.cost.toFixed(2)}/$${row.cap}`
        : `paused: same step failed ${LOOP_LIMIT} times`,
    );
  }
  const question = openQuestion(row);
  if (question !== null) {
    details.push(
      `waiting: asks "${question.text}"${question.toPerson ? " (asked the person)" : ""}`,
    );
  }
  if (row.review?.status === "running") details.push(`review running on ${row.review.model}`);
  if (row.review?.status === "rejected") details.push(`review rejected: ${row.review.reason}`);
  if (row.requestedBy !== null) details.push(`requested by job ${row.requestedBy}`);
  if (row.status === "blocked" && row.block !== null) {
    details.push(`blocked: ${blockReason(row.block)}`);
  }
  const { raises, restarts } = row.attempts;
  if (raises > 0 || restarts > 0) {
    details.push(
      `raises ${raises}/${ESCALATION_LIMITS.raises}, restarts ${restarts}/${ESCALATION_LIMITS.restarts}`,
    );
  }
  return details.length === 0 ? "" : ` (${details.join("; ")})`;
}

/** A job's line in the jobs section. */
const jobLine = (row: JobRow) =>
  `#${row.number} ${row.template} ${row.tier}/${row.effort.applied} ${row.status} $${row.cost.toFixed(2)}/$${row.cap} ${row.title}${jobStateDetails(row)}`;

/**
 * The jobs section: the templates with their start tiers, each live job (and each whose result is
 * under review) as `#<n> <template> <tier>/<applied effort> <status> $<cost>/$<cap> <title>` and
 * its state details, each blocked job with its reason until its result is pulled, how many ended,
 * and what waits for the lead by kind. Results never enter the lead's conversation by themselves.
 */
export function jobsSection(
  board: BoardState,
  templates: readonly JobTemplate[],
  receipts: readonly Pick<Receipt, "status" | "isError" | "readAt">[],
): string {
  const lines = [
    `Job templates (start a job with start_job): ${templates.map((template) => `${template.name} (${template.tier})`).join(", ")}.`,
  ];
  const reviewing = Object.values(board.jobs).filter(
    (row) => ENDED.has(row.status) && row.review?.status === "running",
  );
  const live = [...liveRows(board), ...reviewing].sort((a, b) => a.number - b.number);
  if (live.length === 0) lines.push("No live jobs.");
  else {
    lines.push("Live jobs:");
    for (const row of live) lines.push(jobLine(row));
  }
  const blocked = Object.values(board.jobs)
    .filter((row) => row.status === "blocked" && row.result?.pulledAt === null)
    .sort((a, b) => a.number - b.number);
  if (blocked.length > 0) {
    lines.push(
      "Blocked jobs (read why with job_result; restart one only when the person asks):",
      ...blocked.map(jobLine),
    );
  }
  const rest = restCount(board);
  if (rest > 0) lines.push(`and ${rest} finished or stopped`);
  const counts = waitingCounts(board, receipts);
  const total = counts.failure + counts.question + counts.risky + counts.routine;
  lines.push(
    total === 0
      ? "results waiting: none"
      : `results waiting: failure ${counts.failure}, question ${counts.question}, risky ${counts.risky}, routine ${counts.routine} (pull them with job_result or read_result)`,
  );
  return lines.join("\n");
}

export function createLeadExtension(
  clock: { readonly now: () => number; readonly timeZone: string } = {
    now: Date.now,
    timeZone: "UTC",
  },
): Extension {
  return defineExtension({
    name: "secbot-lead",
    sections: [
      section("bookmark", async (input, context) =>
        bookmarkSection((await input.read.snapshot(BookmarkDoc, context))?.bookmark ?? null),
      ),
      section("time", () => timeSection(clock.now(), clock.timeZone)),
      section("jobs", async (input, context) => {
        const board = (await input.read.snapshot(JobBoardDoc, context)) ?? {
          nextNumber: 1,
          jobs: {},
          byConversation: {},
        };
        const custom = (await input.read.snapshot(TemplatesDoc, context))?.custom ?? {};
        return jobsSection(board, templatesOf(custom), await openReceipts(input.read, context));
      }),
    ],
  });
}
