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
};

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
