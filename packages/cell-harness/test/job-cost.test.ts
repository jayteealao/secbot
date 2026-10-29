// Per-job conversations in the cell's accounting: their role is their template (person rules on
// an agent apply inside its jobs, a developer job waits on the developer budget), telemetry names
// the job, the month ledger counts their spend, and the usage watch stops when the job ends.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobConversations } from "../src/job-board.ts";
import {
  conversationTotal,
  ensureMonth,
  ledgerConversations,
  ledgerListing,
  readMonth,
} from "../src/month-ledger.ts";
import { roleOf } from "../src/telemetry.ts";
import { job, leadCalls } from "./escalation-helpers.ts";
import {
  addJobSpend,
  addSpend,
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type Responder,
  resultReviewer,
  type TestCell,
  until,
} from "./fixtures.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const boardResult = (t: TestCell, n: number) => async () =>
  (await t.cell.board()).jobs[String(n)]?.result != null;

describe("roles of job conversations", () => {
  it("applies a person rule on agent research inside a research job, and logs the job", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const respond: Responder = (request) => {
      if (request.role === "research" && request.last?.role === "user") {
        return fauxAssistantMessage([fauxToolCall("search_history", { query: "flights" })], {
          stopReason: "toolUse",
        });
      }
      if (request.role === "research") return fauxAssistantMessage([fauxText("searched")]);
      return jobResponder(request);
    };
    test = await openTestCell({ gateway: createFauxGateway(respond) });
    const t = test;
    await t.cell.addRule("person", {
      agent: "research",
      tool: "search_history",
      verdict: "prohibit",
    });
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: "look", template: "research" }), "r-1")
    ).wait(BACKGROUND_CONTEXT);
    await until(boardResult(t, 1));

    const row = (await t.cell.board()).jobs["1"];
    const id = row?.conversationId;
    if (id === null || id === undefined) throw new Error("no conversation");
    expect(await roleOf(t.cell.harness, id, BACKGROUND_CONTEXT)).toBe("research");
    const refused = (await t.cell.activity()).records.find(
      (record) => record.kind === "verdict" && record.tool === "search_history",
    );
    expect(refused).toMatchObject({ agent: "research", verdict: "refused", layer: "rule" });
    const calls = loggedEvents(log.mock.calls).filter(
      (event) => event.event === "model.call" && event.role === "research",
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((event) => event.job === 1)).toBe(true);
    expect(
      loggedEvents(log.mock.calls).find((e) => e.event === "model.call" && e.role === "lead"),
    ).toMatchObject({ job: null });
  });

  it("makes a developer job wait on the developer budget, labelled with the job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    await addSpend(t.cell, 60, { role: "developer" });
    await (
      await t.cell.submit(
        startJobLine({ title: "fix", brief: "fix it", template: "developer" }),
        "d-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.waiting()).length === 1);
    expect((await t.cell.waiting())[0]).toMatchObject({
      budget: "developer",
      what: "job 1 developer",
    });
    // Chat with the lead still runs.
    await (await t.cell.submit("hello", "d-2")).wait(BACKGROUND_CONTEXT);
    expect((await t.cell.board()).jobs["1"]?.result).toBeNull();
  });
});

describe("the month ledger counts job conversations", () => {
  it("puts a research job's spend in the person's month, by role and in the hour chart", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: "look", template: "research" }), "m-1")
    ).wait(BACKGROUND_CONTEXT);
    await until(boardResult(t, 1));
    const before = await readMonth(t.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    await addJobSpend(t.cell, 1, 0.5);
    t.cell.budget.watch.trigger();
    await t.cell.budget.watch.settled();
    const after = await readMonth(t.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    expect((after.person.byRole.research ?? 0) - (before.person.byRole.research ?? 0)).toBeCloseTo(
      0.5,
      10,
    );
    expect(after.person.spentUsd - before.person.spentUsd).toBeCloseTo(0.5, 10);
    const hourly = Object.values(after.hours).reduce(
      (all, roles) => all + (roles.research ?? 0),
      0,
    );
    expect(hourly).toBeGreaterThanOrEqual(0.5);
    const conversations = await ledgerConversations(t.cell.harness, BACKGROUND_CONTEXT);
    expect(conversations.find((each) => each.job === 1)).toMatchObject({ role: "research" });
  });

  it("puts a developer job's spend in the developer budget", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: "fix", template: "developer" }), "m-2")
    ).wait(BACKGROUND_CONTEXT);
    await until(boardResult(t, 1));
    const before = await readMonth(t.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    await addJobSpend(t.cell, 1, 2);
    const after = await readMonth(t.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    expect(after.developer.spentUsd - before.developer.spentUsd).toBeCloseTo(2, 10);
    expect(after.person.spentUsd).toBeCloseTo(before.person.spentUsd, 10);
  });
});

describe("usage watches per job", () => {
  it("the watch stops when the job ends", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    const base = t.cell.budget.watching();
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: "look", template: "research" }), "w-1")
    ).wait(BACKGROUND_CONTEXT);
    await until(() => t.cell.budget.watching() === base + 1);
    // Spend inside the running job reaches the limit watch.
    await addJobSpend(t.cell, 1, 0.2);
    await until(async () => (await t.cell.budgetState()).person.spentUsd >= 0.2);
    hold.release("research");
    await until(boardResult(t, 1));
    await until(() => t.cell.budget.watching() === base);
    expect(loggedEvents(log.mock.calls).find((e) => e.event === "job.watch_closed")).toMatchObject({
      job: 1,
      open_watches: base,
    });
  });
});

describe("every conversation of a job is counted (D-051)", () => {
  it("adds a restarted, reviewed job's three conversations to its cost and the month, and closes each watch", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // A health job (risky by its template) fails the same step three times, is restarted with a
    // note, answers, and its result passes review.
    const health: Responder = (request) => {
      if (request.role !== "health") return jobResponder(request);
      if (/Failure note from the earlier attempt/.test(request.lastText)) {
        return fauxAssistantMessage([fauxText("Keep a steady bedtime.")]);
      }
      return fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
        stopReason: "toolUse",
      });
    };
    test = await openTestCell({
      gateway: createFauxGateway(resultReviewer(health), { stepCostUsd: () => 0.01 }),
    });
    const t = test;
    const base = t.cell.budget.watching();
    await (
      await t.cell.submit(
        startJobLine({ title: "sleep", brief: "sleep advice", template: "health" }),
        "c-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.status === "paused");
    await leadCalls(t, "restart_job", {
      job: 1,
      note: "household_read failed; answer from memory.",
    });
    await until(async () => (await job(t))?.review?.status === "passed");

    const row = await job(t);
    if (row === undefined) throw new Error("no row");
    const ids = jobConversations(row);
    expect(ids).toHaveLength(3);
    const totals: number[] = [];
    for (const id of ids) {
      totals.push(
        conversationTotal(await t.cell.harness.snapshot(UsageDoc, id, BACKGROUND_CONTEXT)),
      );
    }
    for (const each of totals) expect(each).toBeGreaterThan(0);
    const sum = totals.reduce((all, each) => all + each, 0);
    expect(row.cost).toBeCloseTo(sum, 10);

    const listed = await ledgerConversations(t.cell.harness, BACKGROUND_CONTEXT);
    expect(
      ids.map((id) => listed.find((each) => each.conversationId === String(id))?.role),
    ).toEqual(["health", "health", "reviewer"]);
    const month = await readMonth(t.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    expect((month.person.byRole.health ?? 0) + (month.person.byRole.reviewer ?? 0)).toBeCloseTo(
      sum,
      10,
    );
    expect(month.person.byLayer.reviewer).toBeCloseTo(totals[2] ?? 0, 10);

    await until(() => t.cell.budget.watching() === base);
    const closed = loggedEvents(log.mock.calls).filter(
      (each) => each.event === "job.watch_closed" && each.job === 1,
    );
    expect(closed.map((each) => each.conversation_id).sort()).toEqual(ids.map(String).sort());
  });
});

describe("jobs that ended before the month", () => {
  it("counts an old job's conversation only when the month's start took its baseline", async () => {
    const { JobBoardDoc, MonthLedgerDoc } = await import("../src/docs.ts");
    const ended = (number: number, conversationId: number) => ({
      number,
      template: "research",
      endedAt: 5_000,
      conversationId,
      runs: [],
      review: null,
    });
    const docs = new Map<unknown, unknown>([
      [JobBoardDoc, { jobs: { "1": ended(1, 21), "2": ended(2, 22) } }],
      // The month began after both ended; only job 1's conversation has a baseline (a late
      // review or charge on it counts; job 2's spend is all in earlier months).
      [MonthLedgerDoc, { startsAt: 10_000, baseline: { "21": { "m:x": 0.3 } } }],
    ]);
    const reader = {
      snapshot: async (doc: unknown) => docs.get(doc),
    } as unknown as Parameters<typeof ledgerConversations>[0];
    const listed = await ledgerConversations(reader, BACKGROUND_CONTEXT);
    expect(listed.filter((each) => each.job !== undefined).map((each) => each.job)).toEqual([1]);
  });

  it("counts a review made after the month began, and leaves out what the start retired", async () => {
    const { JobBoardDoc, MonthLedgerDoc } = await import("../src/docs.ts");
    const docs = new Map<unknown, unknown>([
      [
        JobBoardDoc,
        {
          jobs: {
            // Job 1 ended before the month; the lead pulled its risky result after the roll, so
            // its review conversation (31) is new this month. Job 2's conversation was retired.
            "1": {
              number: 1,
              template: "research",
              endedAt: 5_000,
              conversationId: 21,
              runs: [],
              review: { conversationId: 31 },
            },
            "2": {
              number: 2,
              template: "research",
              endedAt: 5_000,
              conversationId: 22,
              runs: [],
              review: null,
            },
          },
        },
      ],
      [MonthLedgerDoc, { startsAt: 10_000, baseline: {}, retired: { "21": true, "22": true } }],
    ]);
    const reader = {
      snapshot: async (doc: unknown) => docs.get(doc),
    } as unknown as Parameters<typeof ledgerConversations>[0];
    const listed = await ledgerConversations(reader, BACKGROUND_CONTEXT);
    expect(
      listed.filter((each) => each.job !== undefined).map((each) => each.conversationId),
    ).toEqual(["31"]);
  });

  it("retires a quiet old job's conversations at the roll and keeps the ones that spent", async () => {
    const { JobBoardDoc, MonthLedgerDoc } = await import("../src/docs.ts");
    const usage = (cost: number) => ({ models: { x: { cost: { total: cost } } }, tools: {} });
    const row = (number: number, conversationId: number, endedAt: number) => ({
      number,
      template: "research",
      endedAt,
      conversationId,
      runs: [],
      review: null,
    });
    const now = Date.UTC(2026, 10, 2);
    const ledger = {
      month: "2026-10",
      zone: "UTC",
      startsAt: Date.UTC(2026, 9, 1),
      endsAt: Date.UTC(2026, 10, 1),
      nextZone: null,
      // 41 ended in September and spent nothing in October; 42 ended in September and took a
      // late charge in October; 43 ended in October; 44 was left out of October altogether.
      baseline: { "41": { "m:x": 0.2 }, "42": { "m:x": 0.2 } },
      hours: {},
      seen: {},
    };
    const board = {
      jobs: {
        "1": row(1, 41, Date.UTC(2026, 8, 20)),
        "2": row(2, 42, Date.UTC(2026, 8, 20)),
        "3": row(3, 43, Date.UTC(2026, 9, 20)),
        "4": row(4, 44, Date.UTC(2026, 7, 20)),
      },
    };
    const costs: Record<string, unknown> = { "41": usage(0.2), "42": usage(0.5), "43": usage(0.4) };
    const docs = new Map<unknown, unknown>([
      [JobBoardDoc, board],
      [MonthLedgerDoc, ledger],
    ]);
    const tx = {
      doc: async (doc: unknown, id?: unknown) =>
        doc === UsageDoc ? costs[String(id)] : docs.get(doc),
    };
    const harness = {
      snapshot: async (doc: unknown, ...rest: unknown[]) =>
        doc === UsageDoc ? costs[String(rest[0])] : docs.get(doc),
      commit: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
    } as unknown as Parameters<typeof ensureMonth>[0];
    const { included: conversations, excluded } = await ledgerListing(harness, BACKGROUND_CONTEXT);
    expect(conversations.filter((each) => each.job !== undefined).map((each) => each.job)).toEqual([
      1, 2, 3,
    ]);
    expect(excluded.map((each) => each.job)).toEqual([4]);
    const { ledger: rolled, roll } = await ensureMonth(
      harness,
      now,
      "UTC",
      conversations,
      BACKGROUND_CONTEXT,
      excluded,
    );
    expect(roll).toMatchObject({ closedMonth: "2026-10", retired: 2 });
    expect(rolled.month).toBe("2026-11");
    // The lead's own conversation is listed too; only the job conversations matter here.
    const jobIds = Object.keys(rolled.baseline).filter((id) => id.startsWith("4"));
    // A retired conversation keeps its baseline, so a resume counts only its new spend.
    expect(jobIds.sort()).toEqual(["41", "42", "43"]);
    expect(Object.keys(rolled.retired ?? {}).sort()).toEqual(["41", "44"]);
    expect(ledger).toMatchObject({ closed: { "2026-10": 0.7 } });
    const after = await ledgerConversations(harness, BACKGROUND_CONTEXT);
    expect(after.filter((each) => each.job !== undefined).map((each) => each.job)).toEqual([2, 3]);
  });

  it("does not retire a review made between the listing and the roll", async () => {
    const { JobBoardDoc, MonthLedgerDoc } = await import("../src/docs.ts");
    const usage = (cost: number) => ({ models: { x: { cost: { total: cost } } }, tools: {} });
    // Job 1 ended in October; its risky result is pulled while November's roll runs.
    const row: Record<string, unknown> = {
      number: 1,
      template: "research",
      endedAt: Date.UTC(2026, 9, 20),
      conversationId: 61,
      runs: [],
      review: null,
    };
    const ledger: Record<string, unknown> = {
      month: "2026-10",
      zone: "UTC",
      startsAt: Date.UTC(2026, 9, 1),
      endsAt: Date.UTC(2026, 10, 1),
      nextZone: null,
      baseline: {},
      hours: {},
      seen: {},
      retired: {},
    };
    const costs: Record<string, unknown> = { "61": usage(0.3) };
    const docs = new Map<unknown, unknown>([
      [JobBoardDoc, { jobs: { "1": row } }],
      [MonthLedgerDoc, ledger],
    ]);
    const tx = {
      doc: async (doc: unknown, id?: unknown) =>
        doc === UsageDoc ? costs[String(id)] : docs.get(doc),
    };
    const harness = {
      snapshot: async (doc: unknown, ...rest: unknown[]) =>
        doc === UsageDoc ? costs[String(rest[0])] : docs.get(doc),
      commit: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
    } as unknown as Parameters<typeof ensureMonth>[0];
    const { included, excluded } = await ledgerListing(harness, BACKGROUND_CONTEXT);
    // The review starts after the listing and before the roll's commit.
    row.review = { conversationId: 62 };
    costs["62"] = usage(0.1);
    await ensureMonth(
      harness,
      Date.UTC(2026, 10, 2),
      "UTC",
      included,
      BACKGROUND_CONTEXT,
      excluded,
    );
    expect(Object.keys(ledger.retired as Record<string, true>)).toEqual([]);
    costs["62"] = usage(0.25);
    const november = await readMonth(harness, Date.UTC(2026, 10, 3), "UTC", BACKGROUND_CONTEXT);
    // The review's whole cost counts in November; job 1's own run is baselined at 0.3.
    expect(november.person.spentUsd).toBeCloseTo(0.25, 6);
  });

  it("counts none of a resumed job's earlier cost after the roll retired it", async () => {
    const { JobBoardDoc, MonthLedgerDoc } = await import("../src/docs.ts");
    const usage = (cost: number) => ({ models: { x: { cost: { total: cost } } }, tools: {} });
    // Job 1 was stopped in September, baselined at the October roll, and spent nothing in October.
    const row: Record<string, unknown> = {
      number: 1,
      template: "research",
      endedAt: Date.UTC(2026, 8, 20),
      conversationId: 51,
      runs: [],
      review: null,
    };
    const ledger: Record<string, unknown> = {
      month: "2026-10",
      zone: "UTC",
      startsAt: Date.UTC(2026, 9, 1),
      endsAt: Date.UTC(2026, 10, 1),
      nextZone: null,
      baseline: { "51": { "m:x": 0.2 } },
      hours: {},
      seen: {},
      retired: {},
    };
    const costs: Record<string, unknown> = { "51": usage(0.2) };
    const docs = new Map<unknown, unknown>([
      [JobBoardDoc, { jobs: { "1": row } }],
      [MonthLedgerDoc, ledger],
    ]);
    const tx = {
      doc: async (doc: unknown, id?: unknown) =>
        doc === UsageDoc ? costs[String(id)] : docs.get(doc),
    };
    const harness = {
      snapshot: async (doc: unknown, ...rest: unknown[]) =>
        doc === UsageDoc ? costs[String(rest[0])] : docs.get(doc),
      commit: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
    } as unknown as Parameters<typeof readMonth>[0];
    const november = await readMonth(harness, Date.UTC(2026, 10, 2), "UTC", BACKGROUND_CONTEXT);
    expect(november.month).toBe("2026-11");
    expect(Object.keys((ledger.retired as Record<string, true>) ?? {})).toEqual(["51"]);
    // The owner resumes it on 5 November: its old conversation moves to runs, and the new run
    // spends 0.05.
    Object.assign(row, {
      endedAt: null,
      conversationId: 52,
      runs: [{ conversationId: 51 }],
    });
    costs["52"] = usage(0.05);
    const after = await readMonth(harness, Date.UTC(2026, 10, 5), "UTC", BACKGROUND_CONTEXT);
    expect(after.person.spentUsd).toBeCloseTo(0.05, 6);
  });
});
