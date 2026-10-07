// The household tools: a tool call reaches the household cell with an operation id made from the
// cell, the tool task, and the call id, so the same call run again (a rerun after a crash) sends
// the same id and the change applies once.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHouseholdExtension } from "../src/household-tools.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  openTestCell,
  type TestCell,
} from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const toolsOf = (client: ReturnType<typeof createHouseholdStub> | undefined) => {
  const extension = createHouseholdExtension("owner", () => client);
  const byName = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
  return {
    read: byName.get("household_read") as ToolRegistration,
    change: byName.get("household_change") as ToolRegistration,
  };
};

const api = (taskId: number, callId: string) => ({ taskId, callId }) as unknown as ToolExecutionApi;

const textOf = (result: { content?: readonly { type: string; text?: string }[] }) =>
  (result.content ?? []).map((part) => part.text ?? "").join("");

describe("household tools", () => {
  it("a specialist's call adds an item that the lead's read then lists", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const household = createHouseholdStub();
    const gateway = createFauxGateway((request) => {
      if (request.last?.role === "toolResult") {
        return fauxAssistantMessage([fauxText(`seen: ${request.lastText}`)]);
      }
      if (request.role === "lead" && request.lastText === "add milk") {
        return fauxAssistantMessage(
          [fauxToolCall("household_change", { op: "add", text: "milk" })],
          { stopReason: "toolUse" },
        );
      }
      if (request.role === "lead" && request.lastText === "what is on the list") {
        return fauxAssistantMessage([fauxToolCall("household_read", {})], {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage([fauxText("ok")]);
    });
    test = await openTestCell({ gateway, household });
    await (await test.cell.submit("add milk", "req-house-1")).wait(BACKGROUND_CONTEXT);
    expect(household.changes).toHaveLength(1);
    expect(household.changes[0]?.opId).toMatch(/^owner:\d+:/);
    expect(household.changes[0]?.fromCell).toBe("owner");
    await (await test.cell.submit("what is on the list", "req-house-2")).wait(BACKGROUND_CONTEXT);
    expect(gateway.requests.at(-1)?.lastText).toContain("milk");
  });

  it("sends the same operation id when the same call runs again, and the change applies once", async () => {
    const household = createHouseholdStub();
    const { read, change } = toolsOf(household);
    const first = await change.execute(
      { op: "add", text: "eggs" },
      api(41, "call-a"),
      BACKGROUND_CONTEXT,
    );
    const rerun = await change.execute(
      { op: "add", text: "eggs" },
      api(41, "call-a"),
      BACKGROUND_CONTEXT,
    );
    expect(household.changes.map((c) => c.opId)).toEqual(["owner:41:call-a", "owner:41:call-a"]);
    expect(first.details).toMatchObject({ outcome: "applied", duplicate: false });
    expect(rerun.details).toMatchObject({ outcome: "applied", duplicate: true });
    expect((await household.read("list")).items).toHaveLength(1);
    const listed = await read.execute({}, api(42, "call-b"), BACKGROUND_CONTEXT);
    expect(textOf(listed)).toContain("eggs (id owner:41:call-a)");
  });

  it("edits and removes by id, reports a missing item, and refuses bad arguments", async () => {
    const household = createHouseholdStub();
    const { change, read } = toolsOf(household);
    await change.execute({ op: "add", text: "bread" }, api(1, "c1"), BACKGROUND_CONTEXT);
    const edited = await change.execute(
      { op: "edit", itemId: "owner:1:c1", done: true },
      api(2, "c2"),
      BACKGROUND_CONTEXT,
    );
    expect(textOf(edited)).toContain("Changed item owner:1:c1");
    expect(textOf(await read.execute({}, api(3, "c3"), BACKGROUND_CONTEXT))).toContain("[x] bread");
    const removed = await change.execute(
      { op: "remove", itemId: "owner:1:c1" },
      api(4, "c4"),
      BACKGROUND_CONTEXT,
    );
    expect(textOf(removed)).toContain("Removed");
    const missing = await change.execute(
      { op: "remove", itemId: "owner:1:c1" },
      api(5, "c5"),
      BACKGROUND_CONTEXT,
    );
    expect(textOf(missing)).toContain("nothing changed");
    expect(textOf(await read.execute({}, api(6, "c6"), BACKGROUND_CONTEXT))).toContain("empty");
    for (const args of [
      { op: "add" },
      { op: "edit" },
      { op: "edit", itemId: "x" },
      { op: "add", text: "x", document: "Bad Name" },
    ]) {
      const refused = await change.execute(args, api(7, "c7"), BACKGROUND_CONTEXT);
      expect(refused.isError).toBe(true);
    }
    const unreachable = toolsOf(undefined);
    expect((await unreachable.read.execute({}, api(8, "c8"), BACKGROUND_CONTEXT)).isError).toBe(
      true,
    );
    expect(
      (await unreachable.change.execute({ op: "add", text: "x" }, api(9, "c9"), BACKGROUND_CONTEXT))
        .isError,
    ).toBe(true);
  });
});
