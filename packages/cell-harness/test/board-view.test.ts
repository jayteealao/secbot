// The board view: one row per status word with its reason line (byte for byte with the approved
// command-line text), the 24-hour cut, a job waiting above the monthly limit, and the capacity rule.
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  type BoardViewInput,
  boardView,
  budgetJobs,
  dayMonth,
  FINISHED_WINDOW_MS,
} from "../src/board-view.ts";
import type { JobRow } from "../src/docs.ts";
import type { BoardState } from "../src/job-board.ts";
import { JOB_TEMPLATES } from "../src/release-defaults.ts";

const NOW = Date.UTC(2026, 9, 12, 15, 0);
const HOUR = 60 * 60_000;

const base = (number: number, change: Partial<JobRow> = {}): JobRow => ({
  number,
  title: `job ${number}`,
  brief: "brief",
  priority: "routine",
  deadline: null,
  template: "research",
  tier: "mid",
  effort: { requested: "medium", applied: "medium" },
  attempts: { raises: 0, restarts: 0 },
  cost: 0.41,
  cap: 1,
  status: "running",
  owner: "sam",
  conversationId: (100 + number) as unknown as ConversationId,
  taskId: (200 + number) as unknown as TaskId,
  turn: null,
  createdAt: NOW - 2 * HOUR,
  endedAt: null,
  result: null,
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
  ...change,
});

const question = (text: string, toPerson: boolean) => ({
  number: 1,
  from: "job" as const,
  text,
  askedAt: NOW - HOUR,
  toPerson,
  personAskedAt: toPerson ? NOW - HOUR : null,
  answer: null,
  answeredAt: null,
  answeredBy: null,
});

const ended = (status: JobRow["status"], at: number, change: Partial<JobRow> = {}) => ({
  status,
  endedAt: at,
  ...change,
});

function boardOf(rows: JobRow[], queue?: number[]): BoardState {
  return {
    nextNumber: rows.length + 1,
    jobs: Object.fromEntries(rows.map((row) => [String(row.number), row])),
    byConversation: {},
    ...(queue === undefined ? {} : { queue }),
  };
}

const input = (board: BoardState, change: Partial<BoardViewInput> = {}): BoardViewInput => ({
  person: "sam",
  board,
  budgetJobs: new Set(),
  mode: "shadow",
  capacity: { measured: null, at: null },
  templates: JOB_TEMPLATES,
  waiting: 0,
  resetsAt: Date.UTC(2026, 10, 1),
  now: NOW,
  timeZone: "UTC",
  ...change,
});

describe("the board view", () => {
  const rows = [
    base(1, { status: "queued", priority: "deadline", deadline: "2026-10-13" }),
    base(2, { priority: "urgent", attempts: { raises: 1, restarts: 0 } }),
    base(3, { status: "paused", pause: { reason: "cap", at: NOW, detail: "" } }),
    base(4, { status: "paused", pause: { reason: "loop", at: NOW, detail: "" } }),
    base(5, {
      status: "waiting",
      priority: "deadline",
      deadline: "2026-10-20",
      question: question("Which address goes on the form?", true),
    }),
    base(6, { status: "waiting", question: question("Which dates?", false) }),
    base(7, { priority: "research" }),
    base(8, {
      status: "rejected",
      review: {
        status: "rejected",
        model: "m",
        reason: "the prices are not for the brief's dates",
        conversationId: null,
        at: NOW,
      },
    }),
    base(9, ended("done", NOW - HOUR, { effort: { requested: "low", applied: "low" } })),
    base(10, ended("failed", NOW - 2 * HOUR, { result: failure("raise and restart used") })),
    base(11, ended("failed", NOW - 3 * HOUR, { result: failure("the job did not answer") })),
    base(
      12,
      ended("stopped", NOW - 4 * HOUR, {
        stop: { at: Date.UTC(2026, 9, 12, 14, 20), by: "person" },
      }),
    ),
    base(
      13,
      ended("stopped", NOW - 5 * HOUR, { stop: { at: Date.UTC(2026, 9, 12, 9, 5), by: "owner" } }),
    ),
    base(
      14,
      ended("blocked", NOW - 6 * HOUR, {
        block: { cause: "hit", kind: "page", tool: "read_fixture_page", chunk: 1, at: NOW },
      }),
    ),
    base(
      15,
      ended("blocked", NOW - 7 * HOUR, {
        block: { cause: "timeout", kind: "page", tool: "read_fixture_page", chunk: null, at: NOW },
      }),
    ),
    base(16, ended("done", NOW - FINISHED_WINDOW_MS - 1)),
    base(
      17,
      ended("done", NOW - HOUR, {
        review: { status: "running", model: "m", reason: "", conversationId: null, at: NOW },
      }),
    ),
    base(18, { effort: { requested: "high", applied: "xhigh" }, tier: "frontier", cap: 3 }),
  ];

  function failure(text: string) {
    return { kind: "failure" as const, text, at: NOW, pulledAt: null, wokeAt: null };
  }

  it("gives every status its reason line, byte for byte", () => {
    const view = boardView(input(boardOf(rows), { budgetJobs: new Set([7]), waiting: 3 }));
    const reasons = Object.fromEntries(
      [...view.rows, ...view.finished].map((row) => [row.number, [row.status, row.reason?.text]]),
    );
    expect(reasons).toEqual({
      1: ["queued", undefined],
      2: ["running", undefined],
      3: ["paused", "cap reached; the lead asks you before going on"],
      4: ["paused", "same step failed 3 times; the lead decides what next"],
      5: ["waiting", 'asks you: "Which address goes on the form?"  /answer 5 <text>'],
      6: ["waiting", 'asks the lead: "Which dates?"'],
      7: ["waiting", "over your monthly limit; waits for the owner or 1 Nov"],
      8: ["rejected", "review rejected: the prices are not for the brief's dates"],
      9: ["done", undefined],
      10: ["failed", "raise and restart used; the lead asked you"],
      11: ["failed", "the job did not answer"],
      12: ["stopped", "stopped by you at 14:20; secbot jobs restart 12"],
      13: ["stopped", "stopped by the owner at 09:05; secbot jobs restart 13"],
      14: ["blocked", "a page tried to give the agent orders; nothing from it was used"],
      15: ["blocked", "the content check did not answer; stopped to be safe"],
      17: ["running", undefined],
      18: ["running", undefined],
    });
    expect(view).toMatchObject({ person: "sam", mode: "shadow", waiting: 3, capacity: null });
  });

  it("lists live jobs in queue order, then the last 24 hours newest first", () => {
    const view = boardView(input(boardOf(rows)));
    expect(view.rows.map((row) => row.number)).toEqual([2, 1, 5, 3, 4, 6, 8, 18, 7, 17]);
    expect(view.finished.map((row) => row.number)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(view.finished.map((row) => row.number)).not.toContain(16);
    expect(view.shown).toBe(17);
    // A queued job is listed but not counted as live.
    expect(view.live).toBe(9);
  });

  it("shows the priority word, the applied effort, raises and restarts, cost and cap", () => {
    const view = boardView(input(boardOf(rows)));
    const row = (n: number) => view.rows.find((each) => each.number === n);
    expect(row(1)).toMatchObject({ priority: "due 13 Oct", effort: "med", try: "0+0" });
    expect(row(2)).toMatchObject({
      priority: "urgent",
      tier: "mid",
      try: "1+0",
      cost: 0.41,
      cap: 1,
    });
    expect(row(7)?.priority).toBe("research");
    expect(row(18)).toMatchObject({ tier: "frontier", effort: "xhigh", cap: 3 });
    expect(view.finished.find((each) => each.number === 9)?.effort).toBe("low");
    expect(dayMonth("2026-10-01")).toBe("1 Oct");
  });

  it("is empty with the templates and their tiers", () => {
    const view = boardView(input(boardOf([])));
    expect(view).toMatchObject({ live: 0, rows: [], finished: [], shown: 0, capacity: null });
    expect(view.templates).toEqual([
      { name: "household", tier: "cheap" },
      { name: "research", tier: "mid" },
      { name: "health", tier: "mid" },
      { name: "developer", tier: "frontier" },
    ]);
  });

  it("warns only when more jobs run at once than the cell was measured at", () => {
    const running = (count: number) =>
      boardOf(Array.from({ length: count }, (_, i) => base(i + 1)));
    const capacity = { measured: 8, at: Date.UTC(2026, 10, 2, 12) };
    expect(boardView(input(running(9), { capacity })).capacity).toEqual({
      jobsAtOnce: 9,
      measured: 8,
      at: capacity.at,
      on: "2 Nov",
    });
    expect(boardView(input(running(8), { capacity })).capacity).toBeNull();
    expect(boardView(input(running(9))).capacity).toBeNull();
  });

  it("finds the jobs that wait above a monthly limit by task or by request", () => {
    const board = boardOf([base(1), base(2), base(3, ended("done", NOW))]);
    expect(
      [
        ...budgetJobs(board, {
          "201": { what: "job 1 research" },
          "77": { what: "job 2 research" },
          "203": { what: "job 3 result" },
          "88": { what: "job lead" },
        }),
      ].sort(),
    ).toEqual([1, 2]);
  });
});
