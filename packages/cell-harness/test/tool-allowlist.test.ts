// Each role's resolved tool list. This release allows history search, household document read
// and write, and the two secrets tools (a granted secret's value, and a brokered call that never
// shows the agent the token); the lead also holds the hand-off tool, the only routing path, and the
// reminder tool, which only schedules a message to the lead itself. No built-in
// pi-durable tool (read, write, edit, bash) is installed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosterDoc } from "../src/docs.ts";
import { openTestCell, type TestCell } from "./fixtures.ts";

const LEAD_TOOLS = [
  "broker_call",
  "handoff",
  "household_change",
  "household_read",
  "search_history",
  "secret_get",
  "set_reminder",
];
const SPECIALIST_TOOLS = [
  "broker_call",
  "household_change",
  "household_read",
  "search_history",
  "secret_get",
];

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("tool lists", () => {
  it("gives the lead the hand-off, history, household, secrets, and reminder tools, and each specialist history, household, and secrets only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.tools.map((tool) => tool.name).sort()).toEqual(LEAD_TOOLS);
    await test.cell.addSpecialist({ name: "garden", instruction: "Plants." });
    const roster = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    const records = Object.values(roster?.specialists ?? {});
    expect(records).toHaveLength(5);
    for (const record of records) {
      const conversation = await test.cell.harness.conversation(
        record.conversationId,
        BACKGROUND_CONTEXT,
      );
      const agent = await conversation?.agent(BACKGROUND_CONTEXT);
      expect(agent?.tools.map((tool) => tool.name).sort()).toEqual(SPECIALIST_TOOLS);
    }
    const installed = test.cell.extensions.lead.flatMap((extension) => extension.tools ?? []);
    expect(installed.map((tool) => tool.name).sort()).toEqual(LEAD_TOOLS);
  });

  it("puts the guard first in the lead's list and in every specialist's, one added later included", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    expect(test.cell.extensions.lead[0]?.name).toBe("secbot-guard");
    expect(test.cell.extensions.specialist[0]?.name).toBe("secbot-guard");
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.extensions[0]?.name).toBe("secbot-guard");
    await test.cell.addSpecialist({ name: "garden", instruction: "Plants." });
    const roster = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    for (const record of Object.values(roster?.specialists ?? {})) {
      const conversation = await test.cell.harness.conversation(
        record.conversationId,
        BACKGROUND_CONTEXT,
      );
      const agent = await conversation?.agent(BACKGROUND_CONTEXT);
      expect(agent?.extensions[0]?.name).toBe("secbot-guard");
    }
  });

  it("puts the budget check right after the guard on every specialist's list, never the lead's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    expect(test.cell.extensions.specialist[1]?.name).toBe("secbot-budget");
    expect(test.cell.extensions.lead.map((extension) => extension.name)).not.toContain(
      "secbot-budget",
    );
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.extensions.map((extension) => extension.name)).not.toContain("secbot-budget");
    await test.cell.addSpecialist({ name: "garden", instruction: "Plants." });
    const roster = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    for (const record of Object.values(roster?.specialists ?? {})) {
      const conversation = await test.cell.harness.conversation(
        record.conversationId,
        BACKGROUND_CONTEXT,
      );
      const agent = await conversation?.agent(BACKGROUND_CONTEXT);
      expect(agent?.extensions.slice(0, 2).map((extension) => extension.name)).toEqual([
        "secbot-guard",
        "secbot-budget",
      ]);
    }
  });
});
