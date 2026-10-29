// A specialist added through the cell (the CLI's route) is a job template: the lead sees it in
// its next request and can start a job from it on the cheap tier; a model, bad names, duplicates,
// and empty instructions are refused.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusedChange } from "../src/cell-parts.ts";
import { TemplatesDoc } from "../src/docs.ts";
import { TEMPLATE_MODEL_REFUSAL } from "../src/roster.ts";
import {
  ALTERNATE_MODEL,
  createFauxGateway,
  loggedEvents,
  openTestCell,
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

describe("adding a template", () => {
  it("lists it in the lead's next request and starts a cheap job from it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    await t.cell.addSpecialist({
      name: "tax",
      instruction: "You are the tax specialist. Keep track of forms and deadlines.",
    });
    expect((await t.cell.status()).roles).toContain("tax");
    await (
      await t.cell.submit(
        startJobLine({ title: "forms due", brief: "Which forms are due?", template: "tax" }),
        "t-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    const leadRequest = t.gateway.requests.find((r) => r.role === "lead");
    expect(leadRequest?.system).toContain("tax (cheap)");
    await until(async () => (await t.cell.board()).jobs["1"]?.result != null);
    expect((await t.cell.board()).jobs["1"]).toMatchObject({ template: "tax", tier: "cheap" });
    const taxRequest = t.gateway.requests.find((r) => r.role === "tax");
    expect(taxRequest?.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(loggedEvents(log.mock.calls).find((e) => e.event === "specialist.added")).toMatchObject({
      name: "tax",
      start_tier: "cheap",
      outcome: "added",
    });
  });

  it("refuses a model, a bad name, a duplicate, and an empty instruction", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const cell = test.cell;
    const add = (name: string, instruction = "Do things.", model?: string) =>
      cell.addSpecialist(
        model === undefined ? { name, instruction } : { name, instruction, model },
      );
    await expect(add("garden", "Plants.", ALTERNATE_MODEL)).rejects.toThrow(TEMPLATE_MODEL_REFUSAL);
    await expect(add("Tax!")).rejects.toThrow(RefusedChange);
    await expect(add("lead")).rejects.toThrow(RefusedChange);
    await expect(add("cheap")).rejects.toThrow(/tier/);
    await expect(add("research")).rejects.toThrow(/already exists/);
    await expect(add("garden", "  ")).rejects.toThrow(/instruction/);
    await cell.addSpecialist({ name: "garden", instruction: "Plants." });
    await expect(add("garden")).rejects.toThrow(/already exists/);
    expect((await cell.harness.snapshot(TemplatesDoc, BACKGROUND_CONTEXT))?.custom).toEqual({
      garden: { instruction: "Plants.", tier: "cheap" },
    });
  });
});
