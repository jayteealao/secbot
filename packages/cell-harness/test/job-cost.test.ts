// Per-job conversations in the cell's accounting: their role is their template (person rules on
// an agent apply inside its jobs, a developer job waits on the developer budget), telemetry names
// the job, the month ledger counts their spend, and the usage watch stops when the job ends.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roleOf } from "../src/telemetry.ts";
import {
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
import { jobResponder, startJobLine } from "./responders.ts";

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
