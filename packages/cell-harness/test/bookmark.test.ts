// The interrupt bookmark: written only while the lead is busy, replaced by a newer interruption,
// kept until the lead calls resume_work, which returns it and clears it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBookmarkExtension, recordInterruption } from "../src/bookmark.ts";
import { BookmarkDoc } from "../src/docs.ts";
import { createFauxGateway, loggedEvents, openTestCell, type TestCell, until } from "./fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { createHold, jobResponder } from "./responders.ts";

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
      extensions: [createBookmarkExtension("owner", Date.now)],
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
