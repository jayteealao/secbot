// A specialist added through the cell (the CLI's route) is in the lead's next request and
// takes a hand-off; bad names, duplicates, and unknown models are refused.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusedChange } from "../src/cell-parts.ts";
import {
  ALTERNATE_MODEL,
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
    if (request.last?.role === "toolResult" || request.lastText.startsWith("[handoff")) {
      return fauxAssistantMessage([fauxText("done")]);
    }
    if (request.lastText.includes("taxes")) {
      return fauxAssistantMessage(
        [fauxToolCall("handoff", { specialist: "tax", brief: "Which forms are due?" })],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText("hi")]);
  }
  return fauxAssistantMessage([fauxText(`${request.modelId} answered`)]);
}

describe("adding a specialist", () => {
  it("lists it in the lead's next request and accepts a hand-off to it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(responder) });
    const t = test;
    await t.cell.addSpecialist({
      name: "tax",
      instruction: "You are the tax specialist. Keep track of forms and deadlines.",
      model: ALTERNATE_MODEL,
    });
    expect((await t.cell.status()).roles).toContain("tax");
    await (await t.cell.submit("Help with my taxes", "t-1")).wait(BACKGROUND_CONTEXT);
    const leadRequest = t.gateway.requests.find((r) => r.role === "lead");
    expect(leadRequest?.system).toContain("- tax: You are the tax specialist.");
    await until(() => t.gateway.requests.some((r) => r.role === "tax"));
    const taxRequest = t.gateway.requests.find((r) => r.role === "tax");
    expect(taxRequest?.lastText).toBe("Which forms are due?");
    expect(taxRequest?.modelId).toBe(ALTERNATE_MODEL);
  });

  it("refuses a bad name, a duplicate, an empty instruction, and an unknown model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const cell = test.cell;
    const add = (name: string, instruction = "Do things.", model?: string) =>
      cell.addSpecialist(
        model === undefined ? { name, instruction } : { name, instruction, model },
      );
    await expect(add("Tax!")).rejects.toThrow(RefusedChange);
    await expect(add("lead")).rejects.toThrow(RefusedChange);
    await expect(add("research")).rejects.toThrow(/already exists/);
    await expect(add("garden", "  ")).rejects.toThrow(/instruction/);
    await expect(add("garden", "Plants.", "nobody/no-model")).rejects.toThrow(/unknown model/);
    expect((await cell.status()).roles).not.toContain("garden");
  });
});
