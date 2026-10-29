// The interrupt bookmark: written only while the lead is busy, replaced by a newer interruption,
// kept until the lead calls resume_work, which returns it and clears it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordInterruption } from "../src/bookmark.ts";
import { BookmarkDoc } from "../src/docs.ts";
import {
  createFauxGateway,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import {
  answersOf,
  entriesOf,
  entryRole,
  entryText,
  toolCallsOf,
  toolResultsOf,
} from "./job-helpers.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const bookmarkOf = async (t: TestCell) =>
  (await t.cell.harness.snapshot(BookmarkDoc, BACKGROUND_CONTEXT))?.bookmark ?? null;

describe("the interrupt bookmark", () => {
  it("is written only while the lead is busy, replaced, and kept until resume_work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({
      gateway: createFauxGateway(hold.wrap(jobResponder)),
    });
    const t = test;
    // Idle: nothing is interrupted.
    expect(await recordInterruption(t.cell, 1_000, BACKGROUND_CONTEXT)).toBeNull();
    expect(await bookmarkOf(t)).toBeNull();

    hold.hold("lead");
    const first = await t.cell.submit("first", "req-1");
    await until(() => hold.waiting("lead") === 1);
    const written = await recordInterruption(t.cell, 2_000, BACKGROUND_CONTEXT);
    expect(written).toMatchObject({ at: 2_000, receipts: [], jobIds: [], note: null });
    expect(written?.turn).toBe(Number(first.id));
    const replaced = await recordInterruption(t.cell, 3_000, BACKGROUND_CONTEXT);
    expect(replaced?.at).toBe(3_000);
    const events = loggedEvents(log.mock.calls).filter((e) => e.event === "bookmark.recorded");
    expect(events.map((event) => event.replaced)).toEqual([false, true]);

    hold.release("lead");
    await first.wait(BACKGROUND_CONTEXT);
    // Kept after the turn ends, until the lead resumes.
    expect((await bookmarkOf(t))?.at).toBe(3_000);
    await (
      await t.cell.submit('CALL note_bookmark {"sentence":"I was comparing flights."}', "req-2")
    ).wait(BACKGROUND_CONTEXT);
    expect((await bookmarkOf(t))?.note).toBe("I was comparing flights.");

    await (await t.cell.submit("CALL resume_work {}", "req-3")).wait(BACKGROUND_CONTEXT);
    expect(await bookmarkOf(t)).toBeNull();
    const resumed = (await toolResultsOf(t.cell.root)).at(-1) ?? "";
    expect(resumed).toContain("Resume from your bookmark:");
    expect(resumed).toContain("Your note: I was comparing flights.");
    expect(loggedEvents(log.mock.calls).find((e) => e.event === "bookmark.resumed")).toMatchObject({
      had_note: true,
    });
    expect(JSON.stringify(loggedEvents(log.mock.calls))).not.toContain("comparing flights");
  });
});

describe("the person first, with the bookmark wired", () => {
  it("answers a message sent mid-turn before any result, and bookmarks the turn and its jobs (AC-7)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    // The lead's reply step after the job round waits until released, so the lead is mid-turn.
    let replied = () => {};
    const reply = new Promise<void>((resolve) => {
      replied = resolve;
    });
    let replying = 0;
    const respond: Responder = async (request) => {
      if (request.role === "lead" && request.last?.role === "toolResult" && replying === 0) {
        replying++;
        await reply;
      }
      return jobResponder(request);
    };
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(respond)) });
    const t = test;
    const three = ["one", "two", "three"]
      .map((title) => startJobLine({ title, brief: `Look into ${title}.`, template: "research" }))
      .join("\n");
    const turn = await t.cell.submit(three, "req-1");
    await until(() => hold.waiting("research") === 3 && replying === 1);
    const person = await t.cell.submit("What time is it?", "req-2");
    const bookmark = await bookmarkOf(t);
    expect(bookmark).toMatchObject({ turn: Number(turn.id), jobIds: [1, 2, 3], note: null });
    replied();
    await person.wait(BACKGROUND_CONTEXT);
    await turn.wait(BACKGROUND_CONTEXT);

    const calls = await toolCallsOf(t.cell.root);
    expect(calls).not.toContain("job_result");
    const said = await answersOf(t.cell.root);
    expect(said).toContain("lead says: What time is it?");
    // The person's line came after the job round and before any result reached the lead.
    const order = (await entriesOf(t.cell.root)).map(
      (entry) => `${entryRole(entry)}:${entryText(entry).slice(0, 20)}`,
    );
    const asked = order.indexOf("user:What time is it?");
    expect(asked).toBeGreaterThan(order.findIndex((line) => line.startsWith("toolResult:")));
    expect(order.slice(asked + 1).some((line) => line.startsWith("assistant:lead says"))).toBe(
      true,
    );
    hold.release("research");
  });

  it("shows the bookmark in the next request until resume_work clears it (AC-8)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    hold.hold("lead");
    const first = await t.cell.submit("first", "req-1");
    await until(() => hold.waiting("lead") === 1);
    const second = await t.cell.submit("second", "req-2");
    hold.release("lead");
    await first.wait(BACKGROUND_CONTEXT);
    await second.wait(BACKGROUND_CONTEXT);
    const seen = t.gateway.requests.find((request) => request.lastText === "second");
    expect(seen?.system).toContain("The person interrupted you at");
    expect(seen?.system).toContain("call resume_work when you are back on it");
    expect(await bookmarkOf(t)).not.toBeNull();

    await (await t.cell.submit("CALL resume_work {}", "req-3")).wait(BACKGROUND_CONTEXT);
    expect(await bookmarkOf(t)).toBeNull();
    expect((await toolResultsOf(t.cell.root)).at(-1)).toContain("Resume from your bookmark:");
  });
});
