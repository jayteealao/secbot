// Messages that arrived while no session was open are listed in order, then not again.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missedPage } from "../src/delivery.ts";
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import { PULL_JOB_1, researchResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("missed messages", () => {
  it("lists the lead's answers, a pulled job result among them, in order, once per device", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(researchResponder) });
    const t = test;
    await (await t.cell.submit("good morning", "m-1")).wait(BACKGROUND_CONTEXT);
    expect((await t.cell.missed("laptop")).messages.map((m) => m.text)).toEqual(["Hello."]);

    await (await t.cell.submit("Find out about fasting", "m-2")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.board()).jobs["1"]?.result != null);
    await (await t.cell.submit(PULL_JOB_1, "m-3")).wait(BACKGROUND_CONTEXT);
    await until(async () => {
      const page = await t.cell.root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
      return page.items.some((e) => JSON.stringify(e.model ?? "").includes("Research says"));
    });
    const missed = (await t.cell.missed("laptop")).messages;
    expect(missed.map((m) => m.kind)).toEqual(["answer", "answer"]);
    expect(missed[0]?.text).toBe("I asked research.");
    expect(missed[1]?.text).toBe("Research says: research finding: evidence is mixed.");
    const ids = missed.map((m) => m.entryId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect((await t.cell.missed("laptop")).messages).toEqual([]);
    // Another device has its own cursor.
    expect((await t.cell.missed("phone")).messages).toHaveLength(3);
  });

  it("still lists a specialist's report from before jobs as a follow-up", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(researchResponder) });
    await (
      await test.cell.submit("[handoff research answered] The Tuesday train is late.", "o-1")
    ).wait(BACKGROUND_CONTEXT);
    const missed = (await test.cell.missed("laptop")).messages;
    expect(missed[0]).toMatchObject({
      kind: "followup",
      from: "research",
      text: "The Tuesday train is late.",
    });
  });

  it("skips what a session already delivered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await (await test.cell.submit("one", "d-1")).wait(BACKGROUND_CONTEXT);
    const first = (await test.cell.missed("laptop")).messages;
    await (await test.cell.submit("two", "d-2")).wait(BACKGROUND_CONTEXT);
    const page = await test.cell.root.entries({}, 1, undefined, BACKGROUND_CONTEXT);
    await test.cell.markDelivered("laptop", Number(page.items[0]?.id));
    await (await test.cell.submit("three", "d-3")).wait(BACKGROUND_CONTEXT);
    expect(first).toHaveLength(1);
    expect((await test.cell.missed("laptop")).messages.map((m) => m.text)).toEqual([
      "lead says: three",
    ]);
  });

  it("pages a long absence oldest first, moving the cursor only past what it returned", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    for (const text of ["one", "two", "three"]) {
      await (await test.cell.submit(text, `p-${text}`)).wait(BACKGROUND_CONTEXT);
    }
    const cell = test.cell;
    const page = (limit: number) =>
      missedPage(cell.harness, cell.root, "tablet", BACKGROUND_CONTEXT, limit);
    const first = await page(2);
    expect(first.messages.map((m) => m.text)).toEqual(["lead says: one", "lead says: two"]);
    expect(first.remaining).toBe(1);
    const second = await page(2);
    expect(second.messages.map((m) => m.text)).toEqual(["lead says: three"]);
    expect(second.remaining).toBe(0);
    expect((await page(2)).messages).toEqual([]);
  });
});
