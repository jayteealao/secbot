/**
 * The lead's prompt sections: the interrupt bookmark (first, only while one exists), the current
 * time, and the job board. Sections render before each request from committed documents
 * (pi-durable README "System Prompt"), so a job result or a template the owner adds is in the
 * lead's next request, and only a changed section is sent again. The time is given to the minute,
 * so it changes at most once a minute.
 */
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { bookmarkText } from "./bookmark.ts";
import { type Bookmark, BookmarkDoc, JobBoardDoc, type Receipt, TemplatesDoc } from "./docs.ts";
import { type BoardState, liveRows, restCount, waitingCounts } from "./job-board.ts";
import { openReceipts } from "./receipts.ts";
import type { JobTemplate } from "./release-defaults.ts";
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
 * The jobs section: the templates with their start tiers, each live job as
 * `#<n> <template> <tier>/<applied effort> <status> $<cost>/$<cap> <title>`, how many ended, and
 * what waits for the lead by kind. Results never enter the lead's conversation by themselves.
 */
export function jobsSection(
  board: BoardState,
  templates: readonly JobTemplate[],
  receipts: readonly Pick<Receipt, "status" | "isError" | "readAt">[],
): string {
  const lines = [
    `Job templates (start a job with start_job): ${templates.map((template) => `${template.name} (${template.tier})`).join(", ")}.`,
  ];
  const live = liveRows(board);
  if (live.length === 0) lines.push("No live jobs.");
  else {
    lines.push("Live jobs:");
    for (const row of live) {
      lines.push(
        `#${row.number} ${row.template} ${row.tier}/${row.effort.applied} ${row.status} $${row.cost.toFixed(2)}/$${row.cap} ${row.title}`,
      );
    }
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
