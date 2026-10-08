// `secbot activity [--month YYYY-MM]`: the person's guard verdicts for a month, newest first. The
// owner reads another person's with `--person <name>` and the operator key.
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
};

const HEADER = "TIME   AGENT      TOOL OR JOB              VERDICT       LAYER       COST";
const STARTS = [0, 7, 18, 43, 57, 67];

/** `handoff -> research` for a hand-off; the tool name otherwise. */
function toolOrJob(record: ActivityRecord): string {
  const args = record.arguments as Record<string, unknown> | undefined;
  if (record.tool === "handoff" && typeof args?.specialist === "string") {
    return `handoff -> ${args.specialist}`;
  }
  return record.tool;
}

export async function activity(
  target: GuardTarget,
  io: Io,
  month: string | undefined,
): Promise<number> {
  if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new CliError("--month takes YYYY-MM, for example 2026-09", 2);
  }
  const answer = await target.request<ActivityAnswer>(
    "GET",
    "activity",
    undefined,
    month === undefined ? "" : `month=${month}`,
  );
  const total = answer.records.reduce((sum, record) => sum + (record.cost ?? 0), 0);
  const who = target.person === undefined ? answer.person : `${answer.person} (operator key)`;
  const lines = [
    rightAligned(`ACTIVITY  ${who}  ${monthName(answer.month)}`, `[ total: ${money2(total)} ]`),
    RULE,
  ];
  const when = month === undefined ? "this month" : `in ${monthName(answer.month)}`;
  if (answer.records.length === 0) {
    lines.push(`no activity ${when}`);
    io.stdout(`${lines.join("\n")}\n`);
    return 0;
  }
  lines.push(HEADER);
  for (const record of answer.records) {
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
  const person = target.person === undefined ? "" : ` --person ${target.person}`;
  lines.push(
    ...wrap(
      `showing ${answer.records.length} of ${answer.total} ${when}; older: secbot activity${person} --month ${previousMonth(answer.month)}`,
      0,
    ),
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
