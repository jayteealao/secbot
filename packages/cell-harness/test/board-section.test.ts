// The lead's prompt sections: the bookmark first (only while one exists), the time, and the jobs
// section with templates, live rows, a count of the rest, and the results waiting by kind.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { emptyJobExtras, JobBoardDoc, type JobRow } from "../src/docs.ts";
import { type BoardState, markUrgent, moveBefore, setDeadline } from "../src/job-board.ts";
import { bookmarkSection, createLeadExtension, jobsSection } from "../src/sections.ts";
import { templatesOf } from "../src/templates.ts";
import { openTestCell } from "./fixtures.ts";

const row = (number: number, fields: Partial<JobRow> = {}): JobRow => ({
  number,
  title: `job title ${number}`,
  brief: "a brief",
  priority: "routine",
  deadline: null,
  template: "research",
  tier: "mid",
  effort: { requested: "low", applied: "medium" },
  attempts: { raises: 0, restarts: 0 },
  cost: 0.1234,
  cap: 1,
  status: "running",
  owner: "owner",
  conversationId: 5 as unknown as ConversationId,
  taskId: 6 as unknown as TaskId,
  turn: 1,
  createdAt: 0,
  endedAt: null,
  result: null,
  ...emptyJobExtras(),
  ...fields,
});

const routine = { kind: "routine", text: "x", at: 1, pulledAt: null, wokeAt: null } as const;

describe("the lead's prompt sections", () => {
  it("puts the bookmark first, then the time, the hand-off note, and the jobs", () => {
    const keys = (createLeadExtension().sections ?? []).map((section) => section.key);
    expect(keys).toEqual(["bookmark", "time", "handoff", "jobs"]);
  });

  it("renders templates, live rows with applied effort and cost against the cap, the rest, and what waits", () => {
    const board = {
      nextNumber: 5,
      byConversation: {},
      jobs: {
        "1": row(1),
        "2": row(2, { status: "done", endedAt: 2, result: routine }),
        "3": row(3, {
          status: "failed",
          endedAt: 2,
          result: { ...routine, kind: "failure" },
        }),
        "4": row(4, { template: "developer", tier: "frontier", cap: 3, status: "queued", cost: 0 }),
      },
    };
    const text = jobsSection(board, templatesOf(), [
      { status: "done", isError: false, readAt: null },
    ]);
    expect(text).toBe(
      [
        "Job templates (start a job with start_job): household (cheap), research (mid), health (mid), developer (frontier).",
        "Live jobs, in queue order:",
        "#1 research mid/medium running routine $0.12/$1 job title 1",
        "#4 developer frontier/medium queued routine $0.00/$3 job title 4",
        "and 2 finished or stopped",
        "results waiting: failure 1, question 0, risky 0, routine 2 (pull them with job_result or read_result)",
      ].join("\n"),
    );
    // Unchanged between two renders with no board change.
    expect(
      jobsSection(board, templatesOf(), [{ status: "done", isError: false, readAt: null }]),
    ).toBe(text);
  });

  it("shows a pause, a question, a review, a request, and the escalations used", () => {
    const question = {
      number: 1,
      from: "job" as const,
      text: "Which airport?",
      askedAt: 1,
      toPerson: false,
      personAskedAt: null,
      answer: null,
      answeredAt: null,
      answeredBy: null,
    };
    const review = {
      status: "running" as const,
      model: "anthropic/claude-opus-5.5",
      reason: "",
      conversationId: null,
      at: 1,
    };
    const board = {
      nextNumber: 9,
      byConversation: {},
      jobs: {
        "1": row(1, {
          status: "paused",
          cost: 0.24,
          cap: 0.25,
          pause: { reason: "cap", at: 1, detail: "" },
        }),
        "2": row(2, {
          status: "paused",
          pause: { reason: "loop", at: 1, detail: "" },
          attempts: { raises: 1, restarts: 0 },
        }),
        "3": row(3, { status: "waiting", question }),
        "4": row(4, { status: "waiting", question: { ...question, toPerson: true } }),
        "5": row(5, { status: "done", endedAt: 2, result: { ...routine, kind: "risky" }, review }),
        "6": row(6, {
          status: "rejected",
          result: { ...routine, kind: "risky" },
          review: { ...review, status: "rejected", reason: "wrong dates" },
        }),
        "7": row(7, { status: "queued", requestedBy: 3, conversationId: null, taskId: null }),
        "8": row(8, { attempts: { raises: 1, restarts: 1 } }),
      },
    };
    const lines = jobsSection(board, templatesOf(), []).split("\n").slice(2, 10);
    expect(lines).toEqual([
      "#1 research mid/medium paused routine $0.24/$0.25 job title 1 (paused: cap $0.24/$0.25)",
      "#2 research mid/medium paused routine $0.12/$1 job title 2 (paused: same step failed 3 times; raises 1/1, restarts 0/1)",
      '#3 research mid/medium waiting routine $0.12/$1 job title 3 (waiting: asks "Which airport?")',
      '#4 research mid/medium waiting routine $0.12/$1 job title 4 (waiting: asks "Which airport?" (asked the person))',
      "#6 research mid/medium rejected routine $0.12/$1 job title 6 (review rejected: wrong dates)",
      "#7 research mid/medium queued routine $0.12/$1 job title 7 (requested by job 3)",
      "#8 research mid/medium running routine $0.12/$1 job title 8 (raises 1/1, restarts 1/1)",
      "#5 research mid/medium done routine $0.12/$1 job title 5 (review running on anthropic/claude-opus-5.5)",
    ]);
  });

  it("lists a shared job with who it is shared with and who pays, and an offer to give", () => {
    const link = {
      household: 3,
      role: "requester" as const,
      with: "alex",
      consent: "joined" as const,
      payer: "half" as const,
      estimateUsd: 0.25,
      outbox: [],
      charges: [],
      resultAt: null,
      waitingBudget: false,
    };
    const board = {
      nextNumber: 4,
      byConversation: {},
      jobs: {
        "1": row(1, { template: "household", tier: "cheap", shared: link }),
        "2": row(2, {
          template: "household",
          tier: "cheap",
          status: "queued",
          shared: { ...link, role: "other", with: "sam", consent: "offered", payer: "them" },
        }),
        "3": row(3, {
          template: "household",
          tier: "cheap",
          status: "failed",
          endedAt: 2,
          shared: { ...link, role: "other", with: "sam", consent: "declined" },
        }),
      },
    };
    const lines = jobsSection(board, templatesOf(), []).split("\n").slice(2, 4);
    expect(lines).toEqual([
      "#1 household cheap/medium running routine $0.12/$1 job title 1 (shared with alex, you pay half)",
      "#2 household cheap/medium queued routine $0.12/$1 job title 2 (offer from sam: give it with offer_shared; shared with sam, sam pays all)",
    ]);
    expect(jobsSection(board, templatesOf(), [])).not.toContain("job title 3");
  });

  it("says when no job is live and nothing waits", () => {
    expect(jobsSection({ nextNumber: 1, jobs: {}, byConversation: {} }, templatesOf(), [])).toBe(
      [
        "Job templates (start a job with start_job): household (cheap), research (mid), health (mid), developer (frontier).",
        "No live jobs.",
        "results waiting: none",
      ].join("\n"),
    );
  });

  it("shows the bookmark only while one exists", () => {
    expect(bookmarkSection(null)).toBeUndefined();
    const text = bookmarkSection({
      turn: 7,
      at: Date.UTC(2026, 9, 28, 9, 30),
      receipts: ["r2"],
      jobIds: [1, 2, 3],
      note: null,
    });
    expect(text).toBe(
      [
        "The person interrupted you at 2026-10-28T09:30Z during turn 7.",
        "Receipts of that turn still open: r2. Jobs you started then: 1, 2, 3.",
        "Add one sentence on what you were doing with note_bookmark.",
        "Answer the person first; call resume_work when you are back on it.",
      ].join("\n"),
    );
  });
});

describe("blocked jobs in the lead's jobs section", () => {
  const failure = (at: number, text: string) =>
    ({ kind: "failure", text, at, pulledAt: null, wokeAt: null }) as const;

  it("lists a blocked job with its reason until its result is pulled, like a failure", () => {
    const board = {
      nextNumber: 4,
      byConversation: {},
      jobs: {
        "1": row(1, {
          status: "blocked",
          endedAt: 2,
          block: { cause: "hit", kind: "page", tool: "read_fixture_page", chunk: 0, at: 2 },
          outside: { at: 1, kinds: ["page"], tools: ["read_fixture_page"] },
          result: failure(2, "a page tried to give the agent orders; nothing from it was used"),
        }),
        "2": row(2, {
          status: "blocked",
          endedAt: 3,
          block: { cause: "timeout", kind: "mail", tool: "read_mail", chunk: 1, at: 3 },
          result: failure(3, "the content check did not answer; stopped to be safe"),
        }),
        "3": row(3, {
          status: "blocked",
          endedAt: 4,
          block: { cause: "error", kind: "file", tool: "read_file", chunk: null, at: 4 },
          result: {
            ...failure(4, "the content check did not answer; stopped to be safe"),
            pulledAt: 5,
          },
        }),
      },
    };
    expect(jobsSection(board, templatesOf(), []).split("\n").slice(1)).toEqual([
      "No live jobs.",
      "Blocked jobs (read why with job_result; restart one only when the person asks):",
      "#1 research mid/medium blocked routine $0.12/$1 job title 1 (blocked: a page tried to give the agent orders; nothing from it was used)",
      "#2 research mid/medium blocked routine $0.12/$1 job title 2 (blocked: the content check did not answer; stopped to be safe)",
      "and 3 finished or stopped",
      "results waiting: failure 2, question 0, risky 0, routine 0 (pull them with job_result or read_result)",
    ]);
  });
});

describe("the lead's jobs section in queue order", () => {
  const four = (): BoardState & { queue: number[]; jobs: Record<string, JobRow> } => ({
    nextNumber: 5,
    byConversation: {},
    queue: [1, 2, 4, 3],
    jobs: {
      "1": row(1, { priority: "urgent" }),
      "2": row(2, { priority: "deadline", deadline: "2026-10-20" }),
      "3": row(3, { priority: "research" }),
      "4": row(4, { priority: "routine" }),
    },
  });
  const order = (board: BoardState) =>
    jobsSection(board, templatesOf(), [])
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .map((line) =>
        line
          .split(" ")
          .slice(0, 1)
          .concat(line.split(" ")[4] ?? "")
          .join(" "),
      );

  it("lists live jobs in queue order with their priority words", () => {
    expect(order(four())).toEqual(["#1 urgent", "#2 due", "#4 routine", "#3 research"]);
    expect(jobsSection(four(), templatesOf(), [])).toContain(
      "#2 research mid/medium running due 2026-10-20 $0.12/$1 job title 2",
    );
  });

  it("follows the person's reorder: urgent, deadline, move", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const test = await openTestCell();
    try {
      const ops = <T>(change: (tx: Tx) => Promise<T>) =>
        test.cell.harness.commit(change, BACKGROUND_CONTEXT);
      await ops(async (tx) => {
        const board = await tx.doc(JobBoardDoc);
        Object.assign(board, structuredClone(four()));
      });
      const section = async () => order(await test.cell.board());
      expect(await section()).toEqual(["#1 urgent", "#2 due", "#4 routine", "#3 research"]);
      await ops((tx) => markUrgent(tx, 4));
      expect(await section()).toEqual(["#4 urgent", "#1 urgent", "#2 due", "#3 research"]);
      await ops((tx) => setDeadline(tx, 4, "2026-10-12"));
      expect(await section()).toEqual(["#1 urgent", "#4 due", "#2 due", "#3 research"]);
      await ops((tx) => moveBefore(tx, 3, 1));
      expect(await section()).toEqual(["#3 research", "#1 urgent", "#4 due", "#2 due"]);
      // No board change, no section change.
      const board = await test.cell.board();
      expect(jobsSection(board, templatesOf(), [])).toBe(jobsSection(board, templatesOf(), []));
    } finally {
      await test.cell.close();
    }
  });
});
