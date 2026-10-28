// The job documents (board, receipts, bookmark, custom templates, tier settings) and the board
// operations: each document commits and reads back as written.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BookmarkDoc,
  JobBoardDoc,
  type JobRow,
  ReceiptDoc,
  TemplatesDoc,
  TierSettingsDoc,
} from "../src/docs.ts";
import {
  createJobRow,
  endRow,
  liveRows,
  pullResult,
  recordCost,
  restCount,
  setTierEffort,
  storeResult,
  waitingCounts,
} from "../src/job-board.ts";
import { openTestCell, type TestCell } from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const row: JobRow = {
  number: 1,
  title: "flights to Lisbon",
  brief: "Compare direct flights to Lisbon in May.",
  priority: "deadline",
  deadline: "2026-11-30",
  template: "research",
  tier: "mid",
  effort: { requested: "low", applied: "medium" },
  attempts: { raises: 0, restarts: 0 },
  cost: 0.12,
  cap: 1,
  status: "running",
  owner: "owner",
  conversationId: 7 as unknown as ConversationId,
  taskId: 9 as unknown as TaskId,
  turn: 3,
  createdAt: 1_000,
  endedAt: null,
  result: null,
  pause: null,
  question: null,
  risky: { code: [], lead: null },
  toolsUsed: [],
  runs: [],
  review: null,
  requestedBy: null,
};

/** A row with every field this slice adds set. */
const fullRow: JobRow = {
  ...row,
  // No live conversation: the reopen below creates ledgers only for real ones.
  conversationId: null,
  status: "paused",
  pause: { reason: "cap", at: 2_000, detail: "$0.24 of $0.25" },
  question: {
    number: 2,
    from: "job",
    text: "Which address goes on the form?",
    askedAt: 2_100,
    toPerson: true,
    personAskedAt: 2_200,
    answer: "home",
    answeredAt: 2_300,
    answeredBy: "person",
  },
  risky: { code: ["household_change acts"], lead: "spends money" },
  toolsUsed: ["household_read", "household_change"],
  runs: [
    {
      conversationId: 5 as unknown as ConversationId,
      taskId: 6 as unknown as TaskId,
      startedAt: 1_000,
      endedAt: 1_500,
      note: "the search failed on the dates",
    },
  ],
  review: {
    status: "rejected",
    model: "anthropic/claude-opus-5.5",
    reason: "the prices are not for the brief's dates",
    conversationId: 8 as unknown as ConversationId,
    at: 2_400,
  },
  requestedBy: 4,
};

describe("the job board upgrade", () => {
  it("is version 2 and migrates a version-1 board, field by field", () => {
    expect(JobBoardDoc.definition.version).toBe(2);
    const { pause, question, risky, toolsUsed, runs, review, requestedBy, ...v1 } = row;
    const migrated = JobBoardDoc.definition.migrate?.(
      { nextNumber: 2, jobs: { "1": v1 }, byConversation: { "7": 1 } } as never,
      1,
    );
    const upgraded = migrated?.jobs["1"];
    expect(upgraded?.pause).toBeNull();
    expect(upgraded?.question).toBeNull();
    expect(upgraded?.risky).toEqual({ code: [], lead: null });
    expect(upgraded?.toolsUsed).toEqual([]);
    expect(upgraded?.runs).toEqual([]);
    expect(upgraded?.review).toBeNull();
    expect(upgraded?.requestedBy).toBeNull();
    expect(migrated).toEqual({ nextNumber: 2, jobs: { "1": row }, byConversation: { "7": 1 } });
  });

  it("round-trips every new field through a commit and a snapshot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const { harness } = test.cell;
    await harness.commit(async (tx) => {
      (await tx.doc(JobBoardDoc)).jobs["1"] = structuredClone(fullRow);
    }, BACKGROUND_CONTEXT);
    expect((await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"]).toEqual(fullRow);
    await test.reopen();
    expect((await test.cell.board()).jobs["1"]).toEqual(fullRow);
  });
});

describe("the job documents", () => {
  it("round-trips every document through a commit and a snapshot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const { harness } = test.cell;
    await harness.commit(async (tx) => {
      const board = await tx.doc(JobBoardDoc);
      board.nextNumber = 2;
      board.jobs["1"] = structuredClone(row);
      board.byConversation["7"] = 1;
      const receipt = await tx.doc(ReceiptDoc, "r1", null);
      receipt.receipt = {
        number: 1,
        tool: "household_read",
        turn: 3,
        status: "done",
        text: "milk, eggs",
        isError: false,
        sensitive: false,
        at: 2_000,
        readAt: null,
      };
      (await tx.doc(BookmarkDoc)).bookmark = {
        turn: 3,
        at: 2_500,
        receipts: ["r1"],
        jobIds: [1],
        note: "comparing flights",
      };
      (await tx.doc(TemplatesDoc)).custom.travel = {
        instruction: "You are the travel specialist.",
        tier: "cheap",
      };
      (await tx.doc(TierSettingsDoc)).caps.mid = 2;
    }, BACKGROUND_CONTEXT);

    const board = await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT);
    expect(board).toEqual({ nextNumber: 2, jobs: { "1": row }, byConversation: { "7": 1 } });
    expect((await harness.snapshot(ReceiptDoc, "r1", BACKGROUND_CONTEXT))?.receipt).toMatchObject({
      tool: "household_read",
      status: "done",
      text: "milk, eggs",
    });
    expect((await harness.snapshot(BookmarkDoc, BACKGROUND_CONTEXT))?.bookmark).toEqual({
      turn: 3,
      at: 2_500,
      receipts: ["r1"],
      jobIds: [1],
      note: "comparing flights",
    });
    expect((await harness.snapshot(TemplatesDoc, BACKGROUND_CONTEXT))?.custom).toEqual({
      travel: { instruction: "You are the travel specialist.", tier: "cheap" },
    });
    expect((await harness.snapshot(TierSettingsDoc, BACKGROUND_CONTEXT))?.caps).toEqual({ mid: 2 });
  });

  it("starts empty", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await test.cell.harness.commit(async (tx) => {
      expect(await tx.doc(JobBoardDoc)).toEqual({ nextNumber: 1, jobs: {}, byConversation: {} });
      expect((await tx.doc(BookmarkDoc)).bookmark).toBeNull();
      expect((await tx.doc(ReceiptDoc, "r9", null)).receipt).toBeNull();
    }, BACKGROUND_CONTEXT);
  });
});

const fields = (title: string, tier: "cheap" | "mid" | "frontier" = "mid") => ({
  title,
  brief: `Brief: ${title}`,
  priority: "routine" as const,
  deadline: null,
  template: "research",
  tier,
  effort: { requested: "medium" as const, applied: "medium" },
  owner: "owner",
  turn: 4,
  createdAt: 5_000,
});

describe("board operations", () => {
  it("numbers jobs without reuse and puts cost and the tier's cap on every row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const { harness } = test.cell;
    const rows = await harness.commit(async (tx) => {
      (await tx.doc(TierSettingsDoc)).caps.frontier = 4;
      const a = await createJobRow(tx, fields("a", "cheap"));
      const b = await createJobRow(tx, fields("b", "mid"));
      const c = await createJobRow(tx, fields("c", "frontier"));
      return [a.number, b.number, c.number];
    }, BACKGROUND_CONTEXT);
    expect(rows).toEqual([1, 2, 3]);
    const board = await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT);
    expect(Object.values(board?.jobs ?? {}).map((job) => [job.cost, job.cap, job.status])).toEqual([
      [0, 0.25, "queued"],
      [0, 1, "queued"],
      [0, 4, "queued"],
    ]);
    expect(board?.jobs["1"]).toMatchObject({
      attempts: { raises: 0, restarts: 0 },
      owner: "owner",
      turn: 4,
      result: null,
    });
    await harness.commit(async (tx) => {
      await endRow(tx, 3, "stopped", 6_000);
      const d = await createJobRow(tx, fields("d"));
      expect(d.number).toBe(4);
    }, BACKGROUND_CONTEXT);
  });

  it("keeps the requested and the applied effort, and the cap follows the tier", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const { harness } = test.cell;
    await harness.commit(async (tx) => {
      await createJobRow(tx, fields("a", "mid"));
      await setTierEffort(tx, 1, { tier: "cheap", requested: "low", applied: "medium" });
      await recordCost(tx, 1, 0.031);
    }, BACKGROUND_CONTEXT);
    const job = (await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"];
    expect(job).toMatchObject({
      tier: "cheap",
      cap: 0.25,
      cost: 0.031,
      effort: { requested: "low", applied: "medium" },
    });
    await harness.commit(async (tx) => {
      await setTierEffort(tx, 1, { applied: "high", requested: "high" });
    }, BACKGROUND_CONTEXT);
    const raised = (await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"];
    expect(raised).toMatchObject({ tier: "cheap", effort: { requested: "high", applied: "high" } });
  });

  it("stores, counts, and pulls results; live rows and the rest", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const { harness } = test.cell;
    await harness.commit(async (tx) => {
      for (const title of ["a", "b", "c", "d", "e"]) await createJobRow(tx, fields(title));
      await storeResult(tx, 1, "routine", "answer a", 7_000);
      await endRow(tx, 1, "done", 7_000);
      await storeResult(tx, 2, "failure", "the model failed", 7_000);
      await endRow(tx, 2, "failed", 7_000);
      await storeResult(tx, 3, "risky", "answer c", 7_000);
      await endRow(tx, 3, "done", 7_000);
    }, BACKGROUND_CONTEXT);
    const receipts = [
      { status: "done", isError: false, readAt: null },
      { status: "done", isError: true, readAt: null },
      { status: "done", isError: false, readAt: 8_000 },
      { status: "running", isError: false, readAt: null },
    ] as const;
    let board = await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT);
    if (board === undefined) throw new Error("no board");
    expect(waitingCounts(board, receipts)).toEqual({
      failure: 2,
      question: 0,
      risky: 1,
      routine: 2,
    });
    expect(liveRows(board).map((job) => job.number)).toEqual([4, 5]);
    expect(restCount(board)).toBe(3);

    const pulled = await harness.commit((tx) => pullResult(tx, 1, 9_000), BACKGROUND_CONTEXT);
    expect(pulled).toMatchObject({ kind: "routine", text: "answer a", pulledAt: 9_000 });
    const again = await harness.commit((tx) => pullResult(tx, 1, 9_500), BACKGROUND_CONTEXT);
    expect(again?.pulledAt).toBe(9_000);
    board = await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT);
    if (board === undefined) throw new Error("no board");
    expect(waitingCounts(board).routine).toBe(0);
    expect(await harness.commit((tx) => pullResult(tx, 4, 9_000), BACKGROUND_CONTEXT)).toBeNull();
  });
});
