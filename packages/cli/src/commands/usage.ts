/**
 * The month's spend as a person reads it: the usage line printed on connect and after each answer
 * in `secbot chat`, and the limit notices printed in chat and in `secbot missed`. Plain text, no
 * color: every state carries its word (`80% of limit`, `limit reached`), never only a mark.
 */
import { DEVELOPER_BUDGET } from "../budget-names.ts";
import { clock, money2, WIDTH } from "../text.ts";

export type LineState = "normal" | "warn" | "over";

/** The cell's usage frame payload (`GET /v1/cells/<p>/cost` carries the same fields). */
export interface Usage {
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly line: LineState;
  readonly mode: string;
}

/** One task waiting above a limit. */
export interface Waiting {
  readonly what: string;
  readonly since: number;
  readonly budget: string;
}

/** One limit notice: a line of a budget reached in a month. */
export interface Notice {
  readonly seq: number;
  readonly zone: string;
  readonly budget: string;
  readonly line: number;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly resetsAt: number;
}

/** A meter of `cells` cells, filled to the nearest cell and never past full. */
export function meter(percent: number, cells: number): string {
  const filled = Math.min(cells, Math.max(0, Math.round((percent * cells) / 100)));
  return `[${"#".repeat(filled)}${".".repeat(cells - filled)}]`;
}

/** `[ month: $11.52 / $25.00 ] [#####.....] 46% [ shadow ]`, with the state word past 80%. */
export function usageLine(usage: Usage): string {
  const state =
    usage.line === "over" ? " [ limit reached ]" : usage.line === "warn" ? " [ 80% of limit ]" : "";
  return `[ month: ${money2(usage.spentUsd)} / ${money2(usage.limitUsd)} ] ${meter(usage.percent, 10)} ${usage.percent}%${state} [ ${usage.mode} ]`;
}

/** `1 Nov` in `timeZone`. */
export function dayMonth(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
  }).formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("day")} ${part("month")}`;
}

/** The width a notice wraps at, so the contract's lines come out as written. */
export const NOTICE_WIDTH = 76;

/**
 * Words wrapped: the first line flush (or two spaces in with `indentFirst`), every later line two
 * spaces in, none past `width`.
 */
export function noticeLines(text: string, width = NOTICE_WIDTH, indentFirst = false): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const room = lines.length === 0 && !indentFirst ? width : width - 2;
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= room) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((each, index) =>
    (index === 0 && !indentFirst ? each : `  ${each}`).slice(0, WIDTH),
  );
}

/** The text of one notice, before wrapping. */
export function noticeText(notice: Notice): string {
  const spent = money2(notice.spentUsd);
  const limit = money2(notice.limitUsd);
  const day = dayMonth(notice.resetsAt, notice.zone);
  const over = notice.line >= 100;
  let text: string;
  if (notice.budget === DEVELOPER_BUDGET) {
    text = over
      ? `[ developer budget reached ] Developer jobs have used ${spent} of ${limit} this month. They wait until the owner raises the budget or the month resets on ${day}. Nothing is dropped. Other work continues.`
      : `[ 80% of developer budget ] Developer jobs have used ${spent} of ${limit} this month. At ${limit}, developer jobs wait. Other work continues. The budget resets on ${day}.`;
  } else {
    text = over
      ? `[ limit reached ] You have used ${spent} of ${limit} this month. Hand-offs, routines, and reminders wait until the owner raises your limit or the month resets on ${day}. Nothing is dropped. Chat with the lead continues.`
      : `[ 80% of limit ] You have used ${spent} of ${limit} this month. At ${limit}, hand-offs, routines, and reminders wait. Chat with the lead continues. Your limit resets on ${day}.`;
  }
  return text;
}

/** One notice as printed: wrapped, then (over a limit) what waits on that budget. */
export function noticeBlock(notice: Notice, waiting: readonly Waiting[]): string[] {
  const head = noticeLines(noticeText(notice));
  const mine = waiting.filter((each) => each.budget === notice.budget);
  if (notice.line < 100 || mine.length === 0) return head;
  const list = mine.map((each) => `${each.what} (${clock(each.since, notice.zone)})`).join(", ");
  return [...head, ...noticeLines(`${mine.length} waiting: ${list}`, NOTICE_WIDTH, true)];
}
