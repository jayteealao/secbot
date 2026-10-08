// A specialist on a brief calls history search and receives matching messages from the
// lead's history, newest first and bounded.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchHistory } from "../src/history-search.ts";
import {
  createFauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

function responder(request: FauxRequest) {
  if (request.role === "lead") {
    if (request.lastText.startsWith("Hand off")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("handoff", {
            specialist: "household",
            brief: "What did we plan for the kale?",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText(`Noted: ${request.lastText}`)]);
  }
  if (request.role === "household") {
    if (request.last?.role === "toolResult") {
      return fauxAssistantMessage([fauxText(`From history: ${request.lastText}`)]);
    }
    return fauxAssistantMessage([fauxToolCall("search_history", { query: "kale soup" })], {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage([fauxText("ok")]);
}

describe("history search", () => {
  it("gives a specialist the matching messages from the lead's history", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(responder) });
    const t = test;
    const seeds = [
      "We will cook kale soup on Sunday",
      "Buy oat milk",
      "Kale soup needs garlic too",
    ];
    for (const [index, text] of seeds.entries()) {
      await (await t.cell.submit(text, `seed-${index}`)).wait(BACKGROUND_CONTEXT);
    }
    await (await t.cell.submit("Hand off the kale question", "ask")).wait(BACKGROUND_CONTEXT);
    const sawResult = () =>
      t.gateway.requests.find((r) => r.role === "household" && r.last?.role === "toolResult");
    await until(() => sawResult() !== undefined);
    const result = sawResult()?.lastText ?? "";
    expect(result).toContain("Kale soup needs garlic too");
    expect(result).toContain("We will cook kale soup on Sunday");
    expect(result).not.toContain("oat milk");
    // Newest first.
    expect(result.indexOf("garlic")).toBeLessThan(result.indexOf("Sunday"));
  });

  it("bounds the result and returns nothing for an empty query", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    for (let index = 0; index < 5; index++) {
      await (await test.cell.submit(`tomato note ${index}`, `n-${index}`)).wait(BACKGROUND_CONTEXT);
    }
    const hits = await searchHistory(test.cell.harness, "TOMATO", 3, BACKGROUND_CONTEXT);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.text).toContain("4");
    expect(await searchHistory(test.cell.harness, "   ", 3, BACKGROUND_CONTEXT)).toEqual([]);
  });

  // The lead is one endless conversation kept going by compaction. After a compaction summarizes
  // the older part, history search still finds a message from before the cut, and the lead and a
  // hand-off keep working on the compacted conversation.
  it("still finds a message from before a compaction, and the lead still hands off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(responder) });
    const t = test;
    const filler = "the weekly plan in detail. ".repeat(1_000);
    const seeds = [
      `We will cook kale soup on Sunday, and ${filler}`,
      `Buy oat milk, and ${filler}`,
      `Clean the shed, and ${filler}`,
      `Call the plumber, and ${filler}`,
    ];
    for (const [index, text] of seeds.entries()) {
      await (await t.cell.submit(text, `long-${index}`)).wait(BACKGROUND_CONTEXT);
    }
    const compaction = await t.cell.root.compact(undefined, BACKGROUND_CONTEXT);
    const { state } = await t.cell.harness.waitForTask(compaction, BACKGROUND_CONTEXT);
    expect(state.outcome.status).toBe("completed");
    if (state.outcome.status === "completed" && state.outcome.result.submissionId !== undefined) {
      const placed = await t.cell.harness.submission(
        state.outcome.result.submissionId,
        BACKGROUND_CONTEXT,
      );
      await placed?.wait(BACKGROUND_CONTEXT);
    }
    const page = await t.cell.root.entries({}, 200, undefined, BACKGROUND_CONTEXT);
    expect(page.items.some((entry) => entry.kind === "pi.compaction")).toBe(true);

    const hits = await searchHistory(t.cell.harness, "kale soup", 5, BACKGROUND_CONTEXT);
    expect(hits.some((hit) => hit.text.includes("We will cook kale soup on Sunday"))).toBe(true);

    await (await t.cell.submit("Hand off the kale question", "ask-after")).wait(BACKGROUND_CONTEXT);
    const sawResult = () =>
      t.gateway.requests.find((r) => r.role === "household" && r.last?.role === "toolResult");
    await until(() => sawResult() !== undefined);
    expect(sawResult()?.lastText ?? "").toContain("We will cook kale soup on Sunday");
  }, 30_000);
});
