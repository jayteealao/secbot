// The job board as the person reads it: the approved example board byte for byte, every reason
// line, the shared row, the empty board, the capacity line, a row whose tier overflows its column,
// and a title holding an escape sequence. No line passes 80 columns and no byte is a control code.
import { describe, expect, it } from "vitest";
import {
  type BoardRow,
  type BoardView,
  boardLines,
  capText,
  rowLines,
  titleCell,
} from "../src/commands/jobs.ts";

const row = (fields: Partial<BoardRow> & Pick<BoardRow, "number" | "title">): BoardRow => ({
  priority: "routine",
  tier: "mid",
  effort: "med",
  try: "0+0",
  cost: 0,
  cap: 1,
  status: "running",
  reason: null,
  ...fields,
});
const reason = (text: string) => ({ code: "x", text });

const TEMPLATES = [
  { name: "household", tier: "cheap" },
  { name: "research", tier: "mid" },
  { name: "health", tier: "mid" },
  { name: "developer", tier: "frontier" },
];

/** The approved example board. */
const example: BoardView = {
  person: "sam",
  mode: "shadow",
  live: 4,
  waiting: 3,
  rows: [
    row({
      number: 14,
      title: "flights to Lisbon in May",
      priority: "urgent",
      try: "1+0",
      cost: 0.41,
    }),
    row({
      number: 16,
      title: "council tax letter",
      priority: "due 13 Oct",
      tier: "cheap",
      effort: "low",
      cost: 0.02,
      cap: 0.25,
      status: "queued",
    }),
    row({
      number: 15,
      title: "plan the May trip",
      tier: "cheap",
      effort: "low",
      cost: 0.09,
      cap: 0.25,
      shared: "shared with alex; you pay half",
    }),
    row({
      number: 12,
      title: "compare broadband deals",
      priority: "research",
      effort: "high",
      try: "1+1",
      cost: 1,
      status: "paused",
      reason: reason("cap reached; the lead asks you before going on"),
    }),
    row({
      number: 11,
      title: "renew passport form",
      priority: "due 20 Oct",
      cost: 0.18,
      status: "waiting",
      reason: reason('asks you: "Which address goes on the form?"  /answer 11 <text>'),
    }),
  ],
  finished: [
    row({
      number: 9,
      title: "bin day check",
      tier: "cheap",
      effort: "low",
      cost: 0.01,
      cap: 0.25,
      status: "done",
    }),
    row({
      number: 8,
      title: "school trip costs",
      priority: "research",
      try: "0+1",
      cost: 0.62,
      status: "failed",
      reason: reason("raise and restart used; the lead asked you"),
    }),
    row({
      number: 7,
      title: "compare gym prices",
      priority: "research",
      tier: "cheap",
      effort: "low",
      cost: 0.03,
      cap: 0.25,
      status: "blocked",
      reason: reason("a page tried to give the agent orders; nothing from it was used"),
    }),
  ],
  shown: 8,
  capacity: null,
  templates: TEMPLATES,
};

const SPEC_BOARD = `JOBS  sam  [ live: 4 ] [ results waiting: 3 ]  [ shadow ]
------------------------------------------------------------------------------
#   TITLE                     PRIORITY    TIER       TRY  COST/CAP   STATUS
14  flights to Lisbon in May  urgent      mid/med    1+0  $0.41/$1   running
16  council tax letter        due 13 Oct  cheap/low  0+0  $0.02/.25  queued
15  plan the May trip         routine     cheap/low  0+0  $0.09/.25  running
      shared with alex; you pay half
12  compare broadband deals   research    mid/high   1+1  $1.00/$1   paused
      cap reached; the lead asks you before going on
11  renew passport form       due 20 Oct  mid/med    0+0  $0.18/$1   waiting
      asks you: "Which address goes on the form?"  /answer 11 <text>
FINISHED (last 24 h)
9   bin day check             routine     cheap/low  0+0  $0.01/.25  done
8   school trip costs         research    mid/med    0+1  $0.62/$1   failed
      raise and restart used; the lead asked you
7   compare gym prices        research    cheap/low  0+0  $0.03/.25  blocked
      a page tried to give the agent orders; nothing from it was used
showing 8; older jobs: secbot activity`;

const fits = (lines: readonly string[]) => {
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(80);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control codes are what it checks.
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  }
};

describe("the job board", () => {
  it("prints the approved example board byte for byte", () => {
    const lines = boardLines(example, false);
    expect(lines.join("\n")).toBe(SPEC_BOARD);
    fits(lines);
  });

  it("prints every reason line at six spaces under its row", () => {
    const reasons = [
      "cap reached; the lead asks you before going on",
      "same step failed 3 times; the lead decides what next",
      "raise and restart used; the lead asked you",
      'asks you: "Which address goes on the form?"  /answer 11 <text>',
      "waiting for alex to agree to share the cost",
      "over your monthly limit; waits for the owner or 1 Nov",
      "stopped by you at 14:20; secbot jobs restart 14",
      "review rejected: the prices are not for the brief's dates",
      "a page tried to give the agent orders; nothing from it was used",
      "the content check did not answer; stopped to be safe",
    ];
    for (const text of reasons) {
      const lines = rowLines(
        row({ number: 14, title: "flights", status: "paused", reason: reason(text) }),
      );
      expect(lines[1]).toBe(`      ${text}`);
      fits(lines);
    }
  });

  it("prints the empty board with its templates", () => {
    const empty: BoardView = {
      ...example,
      live: 0,
      waiting: 0,
      rows: [],
      finished: [],
      shown: 0,
    };
    expect(boardLines(empty, false).join("\n")).toBe(
      [
        "JOBS  sam  [ live: 0 ] [ waiting results: 0 ]  [ shadow ]",
        "-".repeat(78),
        "no jobs running; 0 finished in the last 24 hours",
        "templates: household (cheap), research (mid), health (mid), developer (frontier)",
      ].join("\n"),
    );
  });

  it("prints the capacity line above the column header", () => {
    const lines = boardLines(
      { ...example, capacity: { jobsAtOnce: 9, measured: 8, on: "2 Nov" } },
      false,
    );
    expect(lines[2]).toBe(
      "[ 9 jobs at once; this cell was measured at 8 on 2 Nov ] nothing is held back",
    );
    expect(lines[3]?.startsWith("#   TITLE")).toBe(true);
    fits(lines);
  });

  it("moves TRY to its own line when the tier overflows, and keeps every line in 80 columns", () => {
    const lines = rowLines(
      row({
        number: 21,
        title: "fix the build",
        tier: "frontier",
        effort: "high",
        cost: 2.5,
        cap: 3,
      }),
    );
    expect(lines).toEqual([
      "21  fix the build             routine     frontier/high",
      "                                                     0+0  $2.50/$3   running",
    ]);
    fits(lines);
  });

  it("prints a title's escape sequence as ? and cuts a long title to 21 and ...", () => {
    const lines = rowLines(row({ number: 3, title: "\u001b[31mred\u001b[0m title" }));
    expect(lines[0]?.slice(4, 30).trimEnd()).toBe("?[31mred?[0m title");
    fits(lines);
    expect(titleCell("a title that runs past the column")).toBe("a title that runs pas...");
    expect(titleCell("x".repeat(24))).toBe("x".repeat(24));
  });

  it("writes caps as the board does", () => {
    expect([capText(1), capText(0.25), capText(1.5), capText(3)]).toEqual([
      "$1",
      ".25",
      "$1.50",
      "$3",
    ]);
  });

  it("names the operator key and the person in the header and the footer", () => {
    const lines = boardLines({ ...example, person: "alex" }, true, "alex");
    expect(lines[0]).toBe(
      "JOBS  alex (operator key)  [ live: 4 ] [ results waiting: 3 ]  [ shadow ]",
    );
    expect(lines.at(-1)).toBe("showing 8; older jobs: secbot activity --person alex");
  });
});
