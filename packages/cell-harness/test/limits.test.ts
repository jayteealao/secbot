// Monthly limits on the stand-in: a new person's limit, the owner's change applied to the next
// check, one notice, one owner alert, and one `limit.crossed` at each line (only the higher one
// when a change passes both), the developer budget apart from the person's, work above a limit
// listed and waiting until a raise while chat with the lead is answered, the month reset at local
// midnight on the first, and the usage and notice frames of a session.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusedChange } from "../src/cell-parts.ts";
import type { Frame } from "../src/session-stream.ts";
import {
  addSpend,
  createHouseholdStub,
  loggedEvents,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { ALERT_ENV, incidentStub } from "./outage-fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

/** Runs the limit watch on what is committed now and waits for it (alerts included). */
async function evaluated(cell: TestCell["cell"]): Promise<void> {
  cell.budget.watch.trigger();
  await cell.budget.watch.settled();
}

const crossed = (calls: readonly unknown[][]) =>
  loggedEvents(calls).filter((event) => event.event === "limit.crossed");

describe("monthly limits", () => {
  it("starts a new person at $25.00 and applies the owner's change to the next check", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const before = await test.cell.budgetState();
    expect(before.person).toMatchObject({ spentUsd: 0, limitUsd: 25, line: "normal" });
    expect(before.developer.limitUsd).toBe(50);
    await addSpend(test.cell, 1.5);
    expect(await test.cell.setLimit(1, "owner")).toEqual({ limitUsd: 1, previousUsd: 25 });
    const after = await test.cell.budgetState();
    expect(after.person).toMatchObject({ spentUsd: 1.5, limitUsd: 1, percent: 150, line: "over" });
    for (const bad of [0, -1, 10_001, 1.234, "lots", null]) {
      await expect(test.cell.setLimit(bad, "owner")).rejects.toBeInstanceOf(RefusedChange);
    }
    expect((await test.cell.budgetState()).person.limitUsd).toBe(1);
  });

  it("sends one notice, one owner alert, and one limit.crossed at each line, none below 80%", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { incidents, fetcher } = incidentStub();
    test = await openTestCell({ person: "sam", env: ALERT_ENV, fetch: fetcher });
    await test.cell.setLimit(1, "owner");
    await addSpend(test.cell, 0.79);
    await evaluated(test.cell);
    expect(incidents).toHaveLength(0);
    expect(await test.cell.notices("laptop")).toEqual([]);
    expect(crossed(log.mock.calls)).toEqual([]);

    await addSpend(test.cell, 0.01);
    await evaluated(test.cell);
    expect(incidents.map((incident) => incident.body.summary)).toEqual([
      "Secbot sam cell: 80% of the monthly limit",
    ]);
    expect(String(incidents[0]?.body.description)).not.toMatch(/\$|0\.8/);
    expect((await test.cell.notices("laptop")).map((n) => [n.budget, n.line])).toEqual([
      ["person", 80],
    ]);
    expect(crossed(log.mock.calls)).toEqual([
      expect.objectContaining({
        cell: "sam",
        budget: "person",
        line: 80,
        spend_usd: 0.8,
        limit_usd: 1,
        alerted: true,
      }),
    ]);

    await addSpend(test.cell, 0.2);
    await evaluated(test.cell);
    await addSpend(test.cell, 0.05, { layer: "decision" });
    await evaluated(test.cell);
    await evaluated(test.cell);
    expect(incidents.map((incident) => incident.body.summary)).toEqual([
      "Secbot sam cell: 80% of the monthly limit",
      "Secbot sam cell: monthly limit reached",
    ]);
    expect((await test.cell.notices("laptop")).map((n) => n.line)).toEqual([80, 100]);
    expect(crossed(log.mock.calls).map((event) => event.line)).toEqual([80, 100]);
    // A device that saw them is not shown them again; another device still is.
    await test.cell.notices("laptop", true);
    expect(await test.cell.notices("laptop")).toEqual([]);
    expect(await test.cell.notices("phone")).toHaveLength(2);
  });

  it("sends only the 100% notice and alert when a lowered limit passes both lines at once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { incidents, fetcher } = incidentStub();
    test = await openTestCell({ person: "sam", env: ALERT_ENV, fetch: fetcher });
    await addSpend(test.cell, 0.5);
    await evaluated(test.cell);
    await test.cell.setLimit(0.4, "owner");
    await evaluated(test.cell);
    expect(incidents.map((incident) => incident.body.summary)).toEqual([
      "Secbot sam cell: monthly limit reached",
    ]);
    expect((await test.cell.notices("laptop")).map((n) => n.line)).toEqual([100]);
    expect(crossed(log.mock.calls).map((event) => event.line)).toEqual([100]);
  });

  it("counts the developer's turns and guard calls against the developer budget only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await addSpend(test.cell, 2, { role: "developer" });
    await addSpend(test.cell, 0.25, { role: "developer", layer: "reviewer" });
    await addSpend(test.cell, 1, { role: "research" });
    const state = await test.cell.budgetState();
    expect(state.person.spentUsd).toBeCloseTo(1, 10);
    expect(state.developer.spentUsd).toBeCloseTo(2.25, 10);
    const cost = await test.cell.cost();
    expect(cost.byRole.research).toBe(1);
    expect(cost.byRole.developer).toBeUndefined();
    expect(cost.developer.spentUsd).toBeCloseTo(2.25, 10);
  });

  it("splits the month by layer and by role, the guard's keys apart from the agent model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await addSpend(test.cell, 7.9, { role: "lead" });
    await addSpend(test.cell, 0.41, { role: "lead", layer: "decision" });
    await addSpend(test.cell, 2.31, { role: "research" });
    await addSpend(test.cell, 0.27, { role: "research", layer: "reviewer" });
    const cost = await test.cell.cost();
    expect(cost.byLayer.agent).toBeCloseTo(10.21, 10);
    expect(cost.byLayer.decision).toBeCloseTo(0.41, 10);
    expect(cost.byLayer.reviewer).toBeCloseTo(0.27, 10);
    expect(cost.byRole.lead).toBeCloseTo(8.31, 10);
    expect(cost.byRole.research).toBeCloseTo(2.58, 10);
    expect(cost.spentUsd).toBeCloseTo(10.89, 10);
    expect(cost.limitUsd).toBe(25);
    expect(cost.mode).toBe("shadow");
  });

  it("lists work waiting above the limit, answers chat with the lead, and continues after a raise", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const cell = test.cell;
    await cell.setLimit(1, "owner");
    await addSpend(cell, 1.2);
    let passed = false;
    const waiting = cell.budget.gate
      .waitUntilUnder(
        { budget: "person", taskId: "task-1", what: "routine morning check" },
        BACKGROUND_CONTEXT,
      )
      .then(() => {
        passed = true;
      });
    await until(async () => (await cell.waiting()).length === 1);
    expect(await cell.waiting()).toEqual([
      expect.objectContaining({ what: "routine morning check", budget: "person" }),
    ]);
    // The developer budget is not over, so a developer job does not wait.
    await cell.budget.gate.waitUntilUnder(
      { budget: "developer", taskId: "task-2", what: "job developer" },
      BACKGROUND_CONTEXT,
    );
    // Direct chat with the lead is never gated.
    const before = test.gateway.requests.length;
    await cell.submit("What is on today?", "limit-chat-1");
    await cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(test.gateway.requests.length).toBeGreaterThan(before);
    expect(passed).toBe(false);
    await cell.setLimit(5, "owner");
    await waiting;
    expect(passed).toBe(true);
    expect(await cell.waiting()).toEqual([]);
  });

  it("sends a usage frame after each answer and a notice frame when a line is reached", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const frames: Frame[] = [];
    const stream = await test.cell.session((frame) => frames.push(frame));
    await test.cell.submit("hello", "usage-frame-1");
    await until(() => frames.some((frame) => frame.type === "usage"));
    const answer = frames.findIndex((frame) => frame.type === "answer");
    const usage = frames.findIndex((frame) => frame.type === "usage");
    expect(answer).toBeGreaterThan(-1);
    expect(usage).toBeGreaterThan(answer);
    expect(frames[usage]).toEqual({
      type: "usage",
      usage: expect.objectContaining({ limitUsd: 25, line: "normal", mode: "shadow" }),
    });
    await test.cell.setLimit(1, "owner");
    await addSpend(test.cell, 0.85);
    await evaluated(test.cell);
    await until(() => frames.some((frame) => frame.type === "notice"));
    expect(frames.filter((frame) => frame.type === "notice")).toEqual([
      {
        type: "notice",
        notice: expect.objectContaining({ budget: "person", line: 80, limitUsd: 1 }),
        waiting: [],
      },
    ]);
    await stream.stop();
  });
});

describe("the month", () => {
  it("resets at local midnight on the first, wakes then, and keeps waiting work until it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 9, 31, 23, 59);
    test = await openTestCell({ env: { SECBOT_TIME_ZONE: "Europe/London" }, now: () => clock });
    const cell = test.cell;
    await cell.setLimit(1, "owner");
    await addSpend(cell, 2);
    const october = await cell.budgetState();
    expect(october.spend).toMatchObject({
      month: "2026-10",
      zone: "Europe/London",
      resetsAt: Date.UTC(2026, 10, 1),
    });
    expect(october.person.line).toBe("over");
    expect((await cell.wakes()).next).toEqual({ at: Date.UTC(2026, 10, 1), source: "month-reset" });
    clock = Date.UTC(2026, 10, 1, 0, 1);
    const november = await cell.budgetState();
    expect(november.spend.month).toBe("2026-11");
    expect(november.person.spentUsd).toBe(0);
    expect(november.person.limitUsd).toBe(1);
    await addSpend(cell, 0.3);
    expect((await cell.budgetState()).person.spentUsd).toBeCloseTo(0.3, 10);
  });

  it("keeps the month's start when the household zone changes, and uses the new zone next month", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 9, 15, 12);
    const household = createHouseholdStub(() => clock);
    test = await openTestCell({
      env: { SECBOT_TIME_ZONE: "Europe/London" },
      now: () => clock,
      household,
    });
    const cell = test.cell;
    const before = await cell.budgetState();
    await household.setBudget?.({ timeZone: "Asia/Tokyo" });
    await cell.refreshHouseholdBudget(household);
    const after = await cell.budgetState();
    expect(after.spend.zone).toBe("Europe/London");
    expect(after.spend.startsAt).toBe(before.spend.startsAt);
    expect(after.spend.resetsAt).toBe(before.spend.resetsAt);
    clock = before.spend.resetsAt + 60_000;
    const next = await cell.budgetState();
    expect(next.spend.zone).toBe("Asia/Tokyo");
    expect(next.spend.month).toBe("2026-11");
    // Tokyo's December starts at 15:00 UTC on 30 November.
    expect(next.spend.resetsAt).toBe(Date.UTC(2026, 10, 30, 15));
  });
});
