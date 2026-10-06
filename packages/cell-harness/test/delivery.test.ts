// Messages that arrived while no session was open are listed in order, then not again.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import { handoffResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("missed messages", () => {
  it("lists the lead's answers and relayed follow-ups in order, once per device", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(handoffResponder) });
    const t = test;
    await (await t.cell.submit("good morning", "m-1")).wait(BACKGROUND_CONTEXT);
    expect((await t.cell.missed("laptop")).map((m) => m.text)).toEqual(["Hello."]);

    await (await t.cell.submit("Find out about fasting", "m-2")).wait(BACKGROUND_CONTEXT);
    await until(async () => {
      const page = await t.cell.root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
      return page.items.some((e) => JSON.stringify(e.model ?? "").includes("Research says"));
    });
    const missed = await t.cell.missed("laptop");
    expect(missed.map((m) => m.kind)).toEqual(["answer", "followup", "answer"]);
    expect(missed[0]?.text).toBe("I asked research.");
    expect(missed[1]).toMatchObject({ from: "research" });
    expect(missed[2]?.text).toContain("Research says");
    const ids = missed.map((m) => m.entryId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(await t.cell.missed("laptop")).toEqual([]);
    // Another device has its own cursor.
    expect(await t.cell.missed("phone")).toHaveLength(4);
  });

  it("skips what a session already delivered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await (await test.cell.submit("one", "d-1")).wait(BACKGROUND_CONTEXT);
    const first = await test.cell.missed("laptop");
    await (await test.cell.submit("two", "d-2")).wait(BACKGROUND_CONTEXT);
    const page = await test.cell.root.entries({}, 1, undefined, BACKGROUND_CONTEXT);
    await test.cell.markDelivered("laptop", Number(page.items[0]?.id));
    await (await test.cell.submit("three", "d-3")).wait(BACKGROUND_CONTEXT);
    expect(first).toHaveLength(1);
    expect((await test.cell.missed("laptop")).map((m) => m.text)).toEqual(["lead says: three"]);
  });
});
