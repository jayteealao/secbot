// The lead's hand-off note: before the lead's conversation compacts, the lead's model writes a note
// (open promises, pending questions, recent preferences); it is committed once, booked as the
// lead's spend, and a failing note call keeps the previous note and never stops the compaction.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffNoteDoc } from "../src/docs.ts";
import { HANDOFF_USAGE_KEY } from "../src/release-defaults.ts";
import { localTime } from "../src/reminder.ts";
import { handoffSection } from "../src/sections.ts";
import {
  createFauxGateway,
  defaultResponder,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { isNoteRequest, NOTE_TEXT, noteResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const filler = "the weekly plan in detail. ".repeat(1_000);

/** Fills the lead's conversation, then forces one compaction and waits for it to complete. */
export async function compactLead(t: TestCell, prefix = "long"): Promise<string> {
  const seeds = [
    `Please send me the flight list by Friday, and ${filler}`,
    `I prefer morning flights, and ${filler}`,
    `Which week works for Lisbon? Also ${filler}`,
    `Call the plumber, and ${filler}`,
  ];
  for (const [index, text] of seeds.entries()) {
    await (await t.cell.submit(text, `${prefix}-${index}`)).wait(BACKGROUND_CONTEXT);
  }
  const compaction = await t.cell.root.compact(undefined, BACKGROUND_CONTEXT);
  const { state } = await t.cell.harness.waitForTask(compaction, BACKGROUND_CONTEXT);
  return state.outcome.status;
}

const note = async (t: TestCell) =>
  (await t.cell.harness.snapshot(HandoffNoteDoc, BACKGROUND_CONTEXT))?.note ?? null;

describe("the hand-off note before compaction", () => {
  it("writes the note once with the three headings, and the compaction completes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(noteResponder(defaultResponder)) });
    const t = test;
    expect(await compactLead(t)).toBe("completed");
    const written = await note(t);
    expect(written).toMatchObject({ text: NOTE_TEXT, compactions: 1 });
    for (const heading of ["Open promises:", "Pending questions:", "Recent preferences:"]) {
      expect(written?.text).toContain(heading);
    }
    const noteRequests = t.gateway.requests.filter(isNoteRequest);
    expect(noteRequests).toHaveLength(1);
    // The note call reads the messages about to be summarized, as data.
    expect(noteRequests[0]?.lastText).toContain("<transcript>");
    expect(noteRequests[0]?.lastText).toContain("send me the flight list by Friday");
    const page = await t.cell.root.entries({}, 200, undefined, BACKGROUND_CONTEXT);
    expect(page.items.some((entry) => entry.kind === "pi.compaction")).toBe(true);
    const line = loggedEvents(log.mock.calls).find((each) => each.event === "handoff_note.written");
    expect(line).toMatchObject({ cell: "owner", note_chars: NOTE_TEXT.length });
    expect(JSON.stringify(loggedEvents(log.mock.calls))).not.toContain("flight list");
  }, 60_000);

  it("keeps the previous note when the note call fails, and still compacts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: Responder = (request) => {
      if (isNoteRequest(request)) throw new Error("the note model is down");
      return defaultResponder(request);
    };
    test = await openTestCell({ gateway: createFauxGateway(failing) });
    const t = test;
    const previous = { text: "Open promises:\n- old", at: 1_000, firstKept: "e1", compactions: 3 };
    await t.cell.harness.commit(async (tx) => {
      (await tx.doc(HandoffNoteDoc)).note = { ...previous };
    }, BACKGROUND_CONTEXT);
    expect(await compactLead(t)).toBe("completed");
    expect(await note(t)).toEqual(previous);
    const lines = loggedEvents([...warn.mock.calls]);
    expect(lines.find((line) => line.event === "handoff_note.failed")).toMatchObject({
      cell: "owner",
    });
  }, 60_000);

  it("books the note call as the lead's spend in the person's month", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway(noteResponder(defaultResponder), { stepCostUsd: () => 0.01 }),
    });
    const t = test;
    expect(await compactLead(t)).toBe("completed");
    const usage = await t.cell.harness.snapshot(UsageDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    expect(usage?.tools[HANDOFF_USAGE_KEY]?.cost.total).toBeCloseTo(0.01, 9);
    const rootTotal = (Object.values(usage?.models ?? {}) as { cost: { total: number } }[])
      .concat(Object.values(usage?.tools ?? {}) as { cost: { total: number } }[])
      .reduce((sum, each) => sum + each.cost.total, 0);
    await until(async () => {
      const spent = (await t.cell.budgetState()).person.spentUsd;
      return Math.abs(spent - rootTotal) < 1e-9;
    });
    const view = await t.cell.cost();
    expect(view.byLayer.agent).toBeCloseTo(rootTotal, 9);
  }, 60_000);
});

describe("the hand-off note in the lead's prompt (AC-35)", () => {
  const HEADER = "Your hand-off note from before your last compaction (";

  it("shows the note after the compaction, and again after a restart", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(noteResponder(defaultResponder)) });
    const t = test;
    await (await t.cell.submit("hello", "before")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.system).not.toContain(HEADER);
    expect(await compactLead(t)).toBe("completed");
    await (await t.cell.submit("what did I ask for?", "after")).wait(BACKGROUND_CONTEXT);
    const system = t.gateway.requests.findLast((request) => request.role === "lead")?.system ?? "";
    expect(system).toContain(HEADER);
    expect(system).toContain(NOTE_TEXT);
    expect(system).toContain("Job state is on the job board, not in this note.");
    for (const heading of ["Open promises:", "Pending questions:", "Recent preferences:"]) {
      expect(system).toContain(heading);
    }
    await t.reopen();
    await (await t.cell.submit("and now?", "reopened")).wait(BACKGROUND_CONTEXT);
    const again = t.gateway.requests.findLast((request) => request.role === "lead")?.system ?? "";
    expect(again).toContain(NOTE_TEXT);
  }, 60_000);

  it("renders the section text with the note's local time", () => {
    expect(handoffSection(null, "UTC")).toBeUndefined();
    expect(handoffSection({ text: NOTE_TEXT, at: Date.UTC(2026, 9, 12, 9, 5) }, "UTC")).toBe(
      `${HEADER}${localTime(Date.UTC(2026, 9, 12, 9, 5), "UTC")}):\n${NOTE_TEXT}\nJob state is on the job board, not in this note.`,
    );
  });
});
