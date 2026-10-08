// `secbot activity [--month YYYY-MM] [--page N]`: the person's activity for a month, newest first:
// the jobs running or waiting now (on the first page of the current month), then the stored
// records (guard verdicts, held calls, answers, lapses, finished jobs), 50 to a page, under the
// month's spend. The owner reads another person's with `--person <name>` and the operator key.
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";
import {
  clock,
  columns,
  money2,
  money4,
  monthName,
  previousMonth,
  RULE,
  rightAligned,
  wrap,
} from "../text.ts";
import type { GuardTarget } from "./rules.ts";

type ActivityRecord = {
  at: number;
  agent: string;
  tool: string;
  verdict: string;
  layer: string;
  reason: string;
  arguments?: unknown;
  cost?: number;
};

type ActivityAnswer = {
  person: string;
  month: string;
  timeZone: string;
  total: number;
  records: ActivityRecord[];
  next: number | null;
  /** The person's spend in the month (absent from a cell before this field existed). */
  spentUsd?: number;
  /** Jobs running or waiting now, on the first page of the current month. */
  live?: ActivityRecord[];
};

const HEADER = "TIME   AGENT      TOOL OR JOB              VERDICT       LAYER       COST";
const STARTS = [0, 7, 18, 43, 57, 67];
/** Records per page: the route's default page size. */
export const PAGE_SIZE = 50;

/** `handoff -> research` for a hand-off; the tool name or the job's label otherwise. */
function toolOrJob(record: ActivityRecord): string {
  const args = record.arguments as Record<string, unknown> | undefined;
  if (record.tool === "handoff" && typeof args?.specialist === "string") {
    return `handoff -> ${args.specialist}`;
  }
  return record.tool;
}

/** `--page`: a whole number from 1. */
function pageNumber(page: string | undefined): number {
  if (page === undefined) return 1;
  if (!/^\d{1,6}$/.test(page) || Number(page) < 1) {
    throw new CliError("--page takes a whole number from 1", 2);
  }
  return Number(page);
}

export async function activity(
  target: GuardTarget,
  io: Io,
  month: string | undefined,
  page?: string,
): Promise<number> {
  if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new CliError("--month takes YYYY-MM, for example 2026-09", 2);
  }
  const number = pageNumber(page);
  const read = (before?: number) =>
    target.request<ActivityAnswer>(
      "GET",
      "activity",
      undefined,
      [
        ...(month === undefined ? [] : [`month=${month}`]),
        ...(before === undefined ? [] : [`before=${before}`]),
      ].join("&"),
    );
  // A later page counts back from the month's newest record: the first page gives the count.
  const first = await read();
  const answer =
    number === 1 ? first : await read(Math.max(0, first.total - PAGE_SIZE * (number - 1)));
  // Live jobs join the first page in time order (a job at its start or due time), newest first.
  const live = number === 1 ? (first.live ?? []) : [];
  const rows = [...live, ...answer.records].sort((a, b) => b.at - a.at);
  const total =
    first.spentUsd ?? first.records.reduce((sum, record) => sum + (record.cost ?? 0), 0);
  const who = target.person === undefined ? answer.person : `${answer.person} (operator key)`;
  const lines = [
    rightAligned(`ACTIVITY  ${who}  ${monthName(answer.month)}`, `[ total: ${money2(total)} ]`),
    RULE,
  ];
  const when = month === undefined ? "this month" : `in ${monthName(answer.month)}`;
  if (rows.length === 0) {
    lines.push(`no activity ${when}`);
    io.stdout(`${lines.join("\n")}\n`);
    return 0;
  }
  lines.push(HEADER);
  for (const record of rows) {
    lines.push(
      ...columns(
        [
          clock(record.at, answer.timeZone),
          record.agent,
          toolOrJob(record),
          record.verdict,
          record.layer,
          money4(record.cost ?? 0).padStart(7),
        ],
        STARTS,
      ),
      ...wrap(record.reason, 9),
    );
  }
  const command = [
    "secbot activity",
    ...(target.person === undefined ? [] : [`--person ${target.person}`]),
    ...(month === undefined || answer.next === null ? [] : [`--month ${month}`]),
    answer.next === null ? `--month ${previousMonth(answer.month)}` : `--page ${number + 1}`,
  ].join(" ");
  lines.push(
    ...wrap(
      `showing ${rows.length} of ${first.total + (first.live ?? []).length} ${when}; older: ${command}`,
      0,
    ),
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
