// Local stand-in for check:cells: one harness opens the lead's root conversation, reports up
// with its version and its roles (the lead and the job templates), and a reopen changes nothing.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosterDoc } from "../src/docs.ts";
import { LEAD_INSTRUCTIONS } from "../src/release-defaults.ts";
import { openTestCell, type TestCell } from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const logLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe("the person cell's roster", () => {
  it("opens the lead and reports up with its version and template roles", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    expect(await test.cell.status()).toEqual({
      status: "up",
      person: "owner",
      version: "v0.0.0-test",
      roles: ["lead", "household", "research", "health", "developer"],
    });
    const opened = logLines(log).find((line) => line.event === "harness.opened");
    expect(opened).toMatchObject({ cell: "owner", version: "v0.0.0-test", templates_migrated: 0 });
  });

  it("changes nothing on a second open of the same storage", async () => {
    test = await openTestCell();
    const before = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await test.reopen();
    const after = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    expect(after?.specialists ?? {}).toEqual(before?.specialists ?? {});
    expect(logLines(log).find((line) => line.event === "harness.opened")).toMatchObject({
      templates_migrated: 0,
    });
  });

  it("gives the lead the release instructions and the frontier model", async () => {
    test = await openTestCell();
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.instructions).toBe(LEAD_INSTRUCTIONS);
    expect(lead.model).toEqual({ provider: "openrouter", modelId: "anthropic/claude-opus-5.5" });
  });
});
