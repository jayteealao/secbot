// The lead's prompt sections: the bookmark first (only while one exists), the time, and the jobs
// section with templates, live rows, a count of the rest, and the results waiting by kind.
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { emptyJobExtras, type JobRow } from "../src/docs.ts";
import { bookmarkSection, createLeadExtension, jobsSection } from "../src/sections.ts";
import { templatesOf } from "../src/templates.ts";

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
  it("puts the bookmark first, then the time, then the jobs", () => {
    const keys = (createLeadExtension().sections ?? []).map((section) => section.key);
    expect(keys).toEqual(["bookmark", "time", "jobs"]);
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
        "Live jobs:",
        "#1 research mid/medium running $0.12/$1 job title 1",
        "#4 developer frontier/medium queued $0.00/$3 job title 4",
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
      "#1 research mid/medium paused $0.24/$0.25 job title 1 (paused: cap $0.24/$0.25)",
      "#2 research mid/medium paused $0.12/$1 job title 2 (paused: same step failed 3 times; raises 1/1, restarts 0/1)",
      '#3 research mid/medium waiting $0.12/$1 job title 3 (waiting: asks "Which airport?")',
      '#4 research mid/medium waiting $0.12/$1 job title 4 (waiting: asks "Which airport?" (asked the person))',
      "#5 research mid/medium done $0.12/$1 job title 5 (review running on anthropic/claude-opus-5.5)",
      "#6 research mid/medium rejected $0.12/$1 job title 6 (review rejected: wrong dates)",
      "#7 research mid/medium queued $0.12/$1 job title 7 (requested by job 3)",
      "#8 research mid/medium running $0.12/$1 job title 8 (raises 1/1, restarts 1/1)",
    ]);
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
