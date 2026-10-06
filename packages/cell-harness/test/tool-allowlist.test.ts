// Each role's resolved tool list. Wave 1 allows history search and (with the household lists)
// household document read and write; the lead also holds the hand-off tool, the only routing
// path. No built-in pi-durable tool (read, write, edit, bash) is installed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosterDoc } from "../src/docs.ts";
import { openTestCell, type TestCell } from "./fixtures.ts";

const LEAD_TOOLS = ["handoff", "search_history"];
const SPECIALIST_TOOLS = ["search_history"];

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("tool lists", () => {
  it("gives the lead the hand-off and history search, and each specialist history search only", async () => {
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
      expect(agent?.tools.map((tool) => tool.name)).toEqual(SPECIALIST_TOOLS);
    }
    const installed = test.cell.extensions.lead.flatMap((extension) => extension.tools ?? []);
    expect(installed.map((tool) => tool.name).sort()).toEqual(LEAD_TOOLS);
  });
});
