// The lead's prompt sections: the bookmark first (only while one exists), the time, and the jobs
// section with templates, live rows, a count of the rest, and the results waiting by kind.
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../src/docs.ts";
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
