// Local stand-in for check:cells: one harness opens the lead's root conversation and the four
// specialists, reports up with its version, and a reopen creates nothing new.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosterDoc } from "../src/docs.ts";
import { STARTER_SPECIALISTS } from "../src/release-defaults.ts";
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
  it("opens the lead and the four specialists and reports up with its version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const status = await test.cell.status();
    expect(status).toEqual({
      status: "up",
      person: "owner",
      version: "v0.0.0-test",
      roles: ["lead", "household", "developer", "research", "health"],
    });
    const roster = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    const ids = Object.values(roster?.specialists ?? {}).map((record) => record.conversationId);
    expect(new Set([ROOT_CONVERSATION_ID, ...ids]).size).toBe(5);
    for (const id of ids) {
      expect(await test.cell.harness.conversation(id, BACKGROUND_CONTEXT)).toBeDefined();
    }
    const opened = logLines(log).find((line) => line.event === "harness.opened");
    expect(opened).toMatchObject({ cell: "owner", version: "v0.0.0-test", specialists_created: 4 });
  });

  it("creates no conversation on a second open of the same storage", async () => {
    test = await openTestCell();
    const before = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await test.reopen();
    const after = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    expect(after?.specialists).toEqual(before?.specialists);
    expect(logLines(log).find((line) => line.event === "harness.opened")).toMatchObject({
      specialists_created: 0,
    });
  });

  it("gives every specialist its starter instruction and the cheaper model", async () => {
    test = await openTestCell();
    const roster = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    for (const starter of STARTER_SPECIALISTS) {
      const record = roster?.specialists[starter.name];
      expect(record?.builtIn).toBe(true);
      const conversation = await test.cell.harness.conversation(
        record?.conversationId ?? ROOT_CONVERSATION_ID,
        BACKGROUND_CONTEXT,
      );
      const agent = await conversation?.agent(BACKGROUND_CONTEXT);
      expect(agent?.instructions).toBe(starter.instruction);
      expect(agent?.model).toEqual({
        provider: "openrouter",
        modelId: "anthropic/claude-haiku-4.5",
      });
    }
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.model).toEqual({ provider: "openrouter", modelId: "anthropic/claude-opus-5.5" });
  });
});
