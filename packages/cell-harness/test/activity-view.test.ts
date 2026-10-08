// The activity view's jobs, month total, and retention on the stand-in: a hand-off job shows
// running with its cost so far and is stored once as done with the specialist's spend for it; a
// job above the limit shows waiting; two overlapping hand-offs to one specialist add up to its
// spend; a reminder shows waiting until its time and is stored as done; a routine that spends
// nothing (the heartbeat) is never listed; a restart stores no second done record; records older
// than 90 days are still listed; and the page total is the month ledger's spend.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityRecord } from "../src/activity.ts";
import { leadMessageOf } from "../src/delivery.ts";
import { RosterDoc } from "../src/docs.ts";
import { handoffWhat, jobLabel } from "../src/jobs.ts";
import { readMonth } from "../src/month-ledger.ts";
import { defineRoutine } from "../src/routines.ts";
import {
  addSpend,
  createFauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { BRIEF, handoffResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

async function leadTexts(t: TestCell): Promise<string[]> {
  const page = await t.cell.root.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  return [...page.items]
    .reverse()
    .map((entry: EntryRecord) => leadMessageOf(entry)?.text)
    .filter((text): text is string => text !== undefined);
}

const jobs = async (t: TestCell): Promise<ActivityRecord[]> =>
  (await t.cell.activity({ limit: 200 })).records.filter((record) => record.kind === "job");

const LABEL = jobLabel(handoffWhat("research", BRIEF));

/** A research specialist that answers only once `release()` is called. */
function heldResearch() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responder = async (request: FauxRequest) => {
    if (request.role === "research") await released;
    return handoffResponder(request);
  };
  return { responder, release: () => release() };
}

describe("hand-off jobs in activity", () => {
  it("shows a running job with its cost so far, then stores it once as done with its cost", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const research = heldResearch();
    test = await openTestCell({ gateway: createFauxGateway(research.responder) });
    const t = test;
    await (await t.cell.submit("Find out about fasting for me", "job-1")).wait(BACKGROUND_CONTEXT);
    await until(() => t.gateway.requests.some((request) => request.role === "research"));
    await addSpend(t.cell, 0.131, { role: "research" });

    const running = await t.cell.activity();
    expect(running.live).toHaveLength(1);
    expect(running.live[0]).toMatchObject({
      kind: "job",
      agent: "research",
      tool: LABEL,
      verdict: "running",
      layer: "job",
      reason: "step 1 of 2: research is working",
    });
    expect(running.live[0]?.cost).toBeCloseTo(0.131, 10);
    expect(LABEL).toBe("job: Summarize what is");

    research.release();
    await until(async () => (await leadTexts(t)).some((text) => text.startsWith("Research says")));
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const done = await t.cell.activity();
    expect(done.live).toEqual([]);
    const stored = await jobs(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "job",
      agent: "research",
      tool: LABEL,
      verdict: "done",
      layer: "job",
      reason: "answered the lead",
    });
    expect(stored[0]?.key).toMatch(/^job:\d+$/);
    expect(stored[0]?.cost).toBeCloseTo(0.131, 10);
  }, 30_000);

  it("shows a job above the limit as waiting, and stores it as done after a raise", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(handoffResponder) });
    const t = test;
    await t.cell.setLimit(1, "owner");
    await addSpend(t.cell, 1.2);
    await (await t.cell.submit("Find out about fasting for me", "wait-1")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.waiting()).length === 1);
    const { live } = await t.cell.activity();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ agent: "research", tool: LABEL, verdict: "waiting" });
    expect(live[0]?.reason).toMatch(/^waits above your limit since \d\d:\d\d$/);

    await t.cell.setLimit(5, "owner");
    await until(async () => (await leadTexts(t)).some((text) => text.startsWith("Research says")));
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect((await t.cell.activity()).live).toEqual([]);
    expect((await jobs(t)).map((record) => record.verdict)).toEqual(["done"]);
  }, 30_000);

  it("adds up two overlapping hand-offs to one specialist to that specialist's spend", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder = async (request: FauxRequest) => {
      if (request.role === "research") {
        await released;
        return fauxAssistantMessage([fauxText("research finding: evidence is mixed.")]);
      }
      if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("Asked.")]);
      if (request.lastText === "two") {
        return fauxAssistantMessage(
          [
            fauxToolCall("handoff", { specialist: "research", brief: "trains to Leeds" }),
            fauxToolCall("handoff", { specialist: "research", brief: "buses to Leeds" }),
          ],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage([fauxText("Noted.")]);
    };
    test = await openTestCell({ gateway: createFauxGateway(responder) });
    const t = test;
    await (await t.cell.submit("two", "two-1")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.activity()).live.length === 2);
    await until(() => t.gateway.requests.some((request) => request.role === "research"));
    await addSpend(t.cell, 0.3, { role: "research" });
    release();
    await until(async () => (await jobs(t)).length === 2);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const spend = await readMonth(t.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    const sum = (await jobs(t)).reduce((all, record) => all + record.cost, 0);
    expect(spend.person.byRole.research).toBeCloseTo(0.3, 10);
    expect(sum).toBeCloseTo(0.3, 10);
  }, 30_000);

  it("stores one done record when the cell restarts as the job ends", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(handoffResponder) });
    const t = test;
    await (await t.cell.submit("Find out about fasting for me", "rerun-1")).wait(
      BACKGROUND_CONTEXT,
    );
    const roster = await t.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    const researchId = roster?.specialists.research?.conversationId;
    if (researchId === undefined) throw new Error("no research specialist");
    // Close as soon as the specialist's answer is committed, before or after the job's last commit.
    await until(async () => {
      const conversation = await t.cell.harness.conversation(researchId, BACKGROUND_CONTEXT);
      const page = await conversation?.entries({}, 10, undefined, BACKGROUND_CONTEXT);
      return (page?.items ?? []).some((entry) => entry.kind === "pi.assistant");
    });
    await t.reopen();
    await until(async () => (await jobs(t)).length > 0);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    await t.reopen();
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await jobs(t)).toHaveLength(1);
    expect((await t.cell.activity()).live).toEqual([]);
  }, 30_000);
});

describe("routine jobs in activity", () => {
  it("shows a reminder waiting until its time, then stores it as done at no cost; a routine that spends nothing is never listed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fired: number[] = [];
    const ping = defineRoutine(
      {
        name: "ping",
        every: 1_000,
        spends: false,
        run: async () => {
          fired.push(Date.now());
          return { outcome: "ok" };
        },
      },
      { cell: "owner", timeZone: "UTC" },
    );
    const responder = (request: FauxRequest) => {
      if (request.role !== "lead") return fauxAssistantMessage([fauxText("n/a")]);
      if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("Set.")]);
      if (request.lastText.includes("remind me")) {
        const at = new Date(Date.now() + 1_500).toISOString();
        return fauxAssistantMessage([fauxToolCall("set_reminder", { at, text: "bins out" })], {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage([fauxText("Noted.")]);
    };
    test = await openTestCell({
      gateway: createFauxGateway(responder),
      routines: [{ routine: ping, firstWakeMs: 100 }],
    });
    const t = test;
    await (await t.cell.submit("please remind me about the bins", "rem-1")).wait(
      BACKGROUND_CONTEXT,
    );
    const { live } = await t.cell.activity();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      agent: "lead",
      tool: "reminder: bins out",
      verdict: "waiting",
      layer: "job",
      cost: 0,
    });
    expect(live[0]?.reason).toMatch(/^due \d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/);

    await until(async () => (await jobs(t)).length === 1 && fired.length >= 3);
    const [reminder] = await jobs(t);
    expect(reminder).toMatchObject({
      agent: "lead",
      tool: "reminder: bins out",
      verdict: "done",
      reason: "delivered to the lead",
      cost: 0,
    });
    const view = await t.cell.activity({ limit: 200 });
    expect(view.live).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("ping");
    expect(JSON.stringify(view)).not.toContain("heartbeat");
  }, 30_000);
});

describe("retention and the month total", () => {
  it("lists records older than 90 days by month, and totals each month from the ledger", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 5, 10, 9, 0);
    const responder = (request: FauxRequest) =>
      request.lastText.startsWith("CALL")
        ? fauxAssistantMessage([fauxToolCall("search_history", { query: "bank" })], {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText("ok")]);
    test = await openTestCell({ gateway: createFauxGateway(responder), now: () => clock });
    const t = test;
    await t.cell.addRule("person", { agent: "lead", tool: "search_history", verdict: "prohibit" });
    await (await t.cell.submit("CALL", "old-1")).wait(BACKGROUND_CONTEXT);
    await addSpend(t.cell, 2);
    const june = await t.cell.activity();
    expect(june).toMatchObject({ month: "2026-06", total: 1 });
    expect(june.spentUsd).toBeCloseTo(2, 10);
    expect(june.spentUsd).toBe((await t.cell.budgetState()).person.spentUsd);

    clock = Date.UTC(2026, 9, 8, 12, 0);
    const now = await t.cell.activity();
    expect(now).toMatchObject({ month: "2026-10", total: 0, records: [], live: [], spentUsd: 0 });
    const older = await t.cell.activity({ month: "2026-06" });
    expect(older.total).toBe(1);
    expect(older.records[0]).toMatchObject({ verdict: "refused", layer: "rule" });
    expect(older.live).toEqual([]);
    // June's total is the one the ledger kept when the month ended.
    expect(older.spentUsd).toBe(2);
    // A month the ledger kept nothing for totals its items' cost.
    expect((await t.cell.activity({ month: "2026-03" })).spentUsd).toBe(0);
  }, 30_000);
});
