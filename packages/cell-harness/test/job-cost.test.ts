// Per-job conversations in the cell's accounting: their role is their template (person rules on
// an agent apply inside its jobs, a developer job waits on the developer budget), telemetry names
// the job, the month ledger counts their spend, and the usage watch stops when the job ends.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ledgerConversations, readMonth } from "../src/month-ledger.ts";
import { roleOf } from "../src/telemetry.ts";
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
