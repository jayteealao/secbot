// Risky results (AC-18): code marks a result risky when the job used a tool that acts, spends, or
// touches money, or ran on the health template; the lead can add a mark and never remove one.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { job, leadCalls } from "./escalation-helpers.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
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

/** A household job that adds milk to the list, then answers; every other job answers at once. */
const addsMilk: Responder = (request) => {
  if (request.role === "household" && request.last?.role !== "toolResult") {
    return fauxAssistantMessage([fauxToolCall("household_change", { op: "add", text: "milk" })], {
      stopReason: "toolUse",
    });
  }
  if (request.role !== "lead")
    return fauxAssistantMessage([fauxText("Done: milk is on the list.")]);
  return jobResponder(request);
};

const start = async (t: TestCell, template: string, id: string) =>
  (await t.cell.submit(startJobLine({ title: template, brief: "a brief", template }), id)).wait(
    BACKGROUND_CONTEXT,
  );

describe("risky results (AC-18)", () => {
  it("marks a result risky when the job used a tool that acts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway(addsMilk),
      household: createHouseholdStub(),
    });
    const t = test;
    await start(t, "household", "h-1");
    await until(async () => (await job(t))?.result != null);
    expect(await job(t)).toMatchObject({
      toolsUsed: ["household_change"],
      risky: { code: ["household_change acts"], lead: null },
      result: { kind: "risky" },
    });
  });

  it("marks a health-template result risky with no tool used", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(addsMilk) });
    const t = test;
    await start(t, "health", "h-2");
    await until(async () => (await job(t))?.result != null);
    expect(await job(t)).toMatchObject({
      toolsUsed: [],
      risky: { code: ["health template"], lead: null },
      result: { kind: "risky" },
    });
  });

  it("leaves a result that used only reads routine", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway((request) =>
        request.role === "research" && request.last?.role !== "toolResult"
          ? fauxAssistantMessage([fauxToolCall("search_history", { query: "flights" })], {
              stopReason: "toolUse",
            })
          : addsMilk(request),
      ),
    });
    const t = test;
    await start(t, "research", "h-3");
    await until(async () => (await job(t))?.result != null);
    expect(await job(t)).toMatchObject({
      toolsUsed: ["search_history"],
      risky: { code: [], lead: null },
      result: { kind: "routine" },
    });
  });

  it("refuses the lead's removal of a mark, and the mark stays", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(addsMilk) });
    const t = test;
    await start(t, "health", "h-4");
    await until(async () => (await job(t))?.result != null);
    expect(await leadCalls(t, "mark_risky", { job: 1, reason: "it is fine", risky: false })).toBe(
      "job 1 is marked risky by code; a mark cannot be removed.",
    );
    expect((await job(t))?.risky).toEqual({ code: ["health template"], lead: null });
  });

  it("lets the lead add a mark to an unpulled routine result, and never remove it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(addsMilk) });
    const t = test;
    await start(t, "research", "h-5");
    await until(async () => (await job(t))?.result != null);
    expect((await job(t))?.result?.kind).toBe("routine");
    expect(await leadCalls(t, "mark_risky", { job: 1, reason: "it quotes prices" })).toBe(
      "job 1 is marked risky; its result is checked by a reviewer before you get it.",
    );
    expect(await job(t)).toMatchObject({
      risky: { code: [], lead: "it quotes prices" },
      result: { kind: "risky" },
    });
    expect(await leadCalls(t, "mark_risky", { job: 1, reason: "never mind", risky: false })).toBe(
      "job 1 is marked risky by you; a mark cannot be removed.",
    );
    expect((await job(t))?.risky.lead).toBe("it quotes prices");
  });
});
