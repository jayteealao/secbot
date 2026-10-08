/**
 * Plain text for the guard commands: UTF-8, ASCII framing, no color, no control codes, every line
 * at most 80 columns. Columns are fixed; a value too wide for its column moves the next column to
 * a new line at its own start, and a value wider than the rest of the line wraps at that column.
 */

export const WIDTH = 80;

/** The rule under a section title: 78 dashes. */
export const RULE = "-".repeat(78);

/** Lines for one table row: each cell starts at its column; nothing passes WIDTH. */
export function columns(cells: readonly string[], starts: readonly number[]): string[] {
  const lines: string[] = [];
  let line = "";
  cells.forEach((cell, index) => {
    const start = starts[index] ?? 0;
    if (index > 0 && line.length >= start) {
      lines.push(line.trimEnd());
      line = "";
    }
    const room = Math.max(1, WIDTH - start);
    let rest = cell;
    while (rest.length > room) {
      lines.push(line.padEnd(start) + rest.slice(0, room));
      line = "";
      rest = rest.slice(room);
    }
    line = line.padEnd(start) + rest;
  });
  lines.push(line.trimEnd());
  return lines;
}

/** `text` wrapped at word boundaries to WIDTH, every line indented by `indent` spaces. */
export function wrap(text: string, indent: number): string[] {
  const room = Math.max(10, WIDTH - indent);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > room) {
      if (line !== "") lines.push(line);
      lines.push(rest.slice(0, room));
      line = "";
      rest = rest.slice(room);
    }
    if (line === "") line = rest;
    else if (line.length + 1 + rest.length <= room) line = `${line} ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((each) => `${" ".repeat(indent)}${each}`);
}

/** `left` with `right` ending at column 78 (at least two spaces between them). */
export function rightAligned(left: string, right: string): string {
  return `${left}  `.padEnd(78 - right.length) + right;
}

export const money4 = (usd: number) => `$${usd.toFixed(4)}`;
export const money2 = (usd: number) => `$${usd.toFixed(2)}`;

export type RuleMatch = { kind: string; field: string; value: string };
export type Rule = {
  id?: number;
  agent: string;
  tool: string;
  verdict: string;
  match?: RuleMatch;
  source?: string;
  addedAt?: number;
};

const MATCH_SYMBOL: Record<string, string> = {
  exact: "=",
  prefix: "^=",
  "email-domain": "@",
  "web-domain": "host",
  regex: "~",
};

export function matchText(match: RuleMatch | undefined): string {
  if (match === undefined) return "any";
  const value = match.kind === "regex" ? `/${match.value}/i` : match.value;
  return `${match.field} ${MATCH_SYMBOL[match.kind] ?? match.kind} ${value}`;
}

export const verdictText = (verdict: string) => (verdict === "ask-first" ? "ask first" : verdict);

export const toolText = (tool: string) =>
  tool === "pay" ? "pay tools" : tool === "*" ? "any tool" : tool;

/** A rule as the cell words it, for example `lead handoff (specialist = research) -> permit`. */
export function ruleText(rule: Rule): string {
  return `${rule.agent} ${toolText(rule.tool)} (${matchText(rule.match)}) -> ${verdictText(rule.verdict)}`;
}

/** `8 Oct 14:02` in `timeZone`. */
export function dayTime(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}

/** `14:02` in `timeZone`. */
export function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** `October 2026` for `2026-10`. */
export function monthName(month: string): string {
  const [year = "1970", number = "01"] = month.split("-");
  const name = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
    Date.UTC(Number(year), Number(number) - 1, 15),
  );
  return `${name} ${year}`;
}

/** The month before `2026-10`: `2026-09`. */
export function previousMonth(month: string): string {
  const [year = 1970, number = 1] = month.split("-").map(Number);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`;
}
