// The job documents (board, receipts, bookmark, custom templates, tier settings) and the board
// operations: each document commits and reads back as written.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
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
  answerQuestion,
  askQuestion,
  createJobRow,
  EXHAUSTED,
  endRow,
  escalate,
  escalationsUsed,
  exhaust,
  isRisky,
  jobConversations,
  markRisky,
  pauseRow,
  resumeRow,
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
  resumedAt: null,
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
    const { pause, question, risky, toolsUsed, runs, review, requestedBy, resumedAt, ...v1 } =
      row;
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
    expect(upgraded?.resumedAt).toBeNull();
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

describe("escalation bounds, questions, and risk on the board", () => {
  const ops = async <T>(change: (tx: Tx) => T | Promise<T>): Promise<T> => {
    if (test === undefined) throw new Error("no cell");
    return test.cell.harness.commit(async (tx) => change(tx), BACKGROUND_CONTEXT);
  };
  const job = async (n = 1) => (await test?.cell.board())?.jobs[String(n)];

  it("allows one raise and one restart in either order and refuses a second of each", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await ops(async (tx) => {
      await createJobRow(tx, fields("restart first"));
      await createJobRow(tx, fields("raise first"));
    });
    // Order A: restart, then raise.
    expect(await ops((tx) => escalate(tx, 1, "restart"))).toEqual({ ok: true });
    expect(await ops((tx) => escalate(tx, 1, "restart"))).toEqual({ refused: "restart used" });
    expect(await ops((tx) => escalate(tx, 1, "raise"))).toEqual({ ok: true });
    expect(await ops((tx) => escalate(tx, 1, "raise"))).toEqual({ refused: "raise used" });
    // Order B: raise, then restart.
    expect(await ops((tx) => escalate(tx, 2, "raise"))).toEqual({ ok: true });
    expect(await ops((tx) => escalate(tx, 2, "raise"))).toEqual({ refused: "raise used" });
    expect(await ops((tx) => escalate(tx, 2, "restart"))).toEqual({ ok: true });
    expect(await ops((tx) => escalate(tx, 2, "restart"))).toEqual({ refused: "restart used" });
    for (const n of [1, 2]) {
      const row = await job(n);
      expect(row?.attempts).toEqual({ raises: 1, restarts: 1 });
      expect(row !== undefined && escalationsUsed(row)).toBe(true);
    }
  });

  it("pauses only a running job, keeps the first pause, and resumes it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await ops((tx) => createJobRow(tx, fields("a", "cheap")));
    expect(await ops((tx) => pauseRow(tx, 1, "cap", "queued", 1))).toBe(false);
    await ops(async (tx) => {
      const one = (await tx.doc(JobBoardDoc)).jobs["1"];
      if (one !== undefined) one.status = "running";
    });
    expect(await ops((tx) => pauseRow(tx, 1, "cap", "$0.24 of $0.25", 10))).toBe(true);
    expect(await ops((tx) => pauseRow(tx, 1, "loop", "3 failing steps", 20))).toBe(false);
    expect((await job())?.pause).toEqual({ reason: "cap", at: 10, detail: "$0.24 of $0.25" });
    expect((await job())?.status).toBe("paused");
    expect(await ops((tx) => resumeRow(tx, 1))).toBe(true);
    expect(await job()).toMatchObject({ status: "running", pause: null });
    expect((await job())?.resumedAt).toEqual(expect.any(Number));
    expect(await ops((tx) => resumeRow(tx, 1))).toBe(false);
  });

  it("ends an exhausted job failed with the escalation question to the person", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await ops((tx) => createJobRow(tx, fields("a")));
    await ops((tx) => exhaust(tx, 1, 50));
    expect(await job()).toMatchObject({
      status: "failed",
      endedAt: 50,
      result: { kind: "failure", text: EXHAUSTED },
      question: { number: 1, from: "escalation", toPerson: true, personAskedAt: 50, answer: null },
    });
  });

  it("asks one question at a time, waits, and the first answer wins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await ops(async (tx) => {
      await createJobRow(tx, fields("a"));
      const one = (await tx.doc(JobBoardDoc)).jobs["1"];
      if (one !== undefined) one.status = "running";
    });
    const first = await ops((tx) => askQuestion(tx, 1, "Which address?", 5));
    const again = await ops((tx) => askQuestion(tx, 1, "Another?", 6));
    expect(first).toMatchObject({ number: 1, text: "Which address?" });
    expect(again).toMatchObject({ number: 1, text: "Which address?" });
    expect((await job())?.status).toBe("waiting");
    expect(await ops((tx) => answerQuestion(tx, 1, "home", "lead", 7))).toMatchObject({
      answer: "home",
      answeredBy: "lead",
    });
    expect(await ops((tx) => answerQuestion(tx, 1, "office", "person", 8))).toBeNull();
    expect(await job()).toMatchObject({ status: "running", question: { answer: "home" } });
    const next = await ops((tx) => askQuestion(tx, 1, "Which date?", 9));
    expect(next.number).toBe(2);
  });

  it("adds risky marks and never clears one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await ops((tx) => createJobRow(tx, fields("a")));
    const fresh = await job();
    expect(fresh !== undefined && isRisky(fresh)).toBe(false);
    await ops((tx) => markRisky(tx, 1, { code: ["household_change acts"] }));
    await ops((tx) => markRisky(tx, 1, { code: ["household_change acts", "health template"] }));
    await ops((tx) => markRisky(tx, 1, { lead: "it books a room" }));
    await ops((tx) => markRisky(tx, 1, { lead: "another reason" }));
    await ops((tx) => markRisky(tx, 1, { code: [] }));
    expect((await job())?.risky).toEqual({
      code: ["household_change acts", "health template"],
      lead: "it books a room",
    });
  });

  it("lists every conversation of a job: current, earlier runs, review", () => {
    const id = (n: number) => n as unknown as ConversationId;
    expect(
      jobConversations({
        conversationId: id(9),
        runs: [
          { conversationId: id(3), taskId: null, startedAt: 0, endedAt: 1, note: "n" },
          { conversationId: id(9), taskId: null, startedAt: 0, endedAt: 1, note: "dup" },
        ],
        review: { status: "passed", model: "m", reason: "", conversationId: id(11), at: 2 },
      }),
    ).toEqual([id(9), id(3), id(11)]);
    expect(jobConversations({ conversationId: null, runs: [], review: null })).toEqual([]);
  });
});
