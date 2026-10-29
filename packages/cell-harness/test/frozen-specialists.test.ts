// A cell opened before jobs keeps its specialists frozen: their conversations and the lead's
// history stay, no conversation is created, an owner-added specialist becomes a cheap-tier
// template, and the lead finds the old relayed answers through search_history.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosterDoc, TemplatesDoc } from "../src/docs.ts";
import { Anchor } from "../src/handoff.ts";
import { modelRef } from "../src/model-map.ts";
import { createFauxGateway, loggedEvents, openTestCell, type TestCell } from "./fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { jobResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const WAVE_TWO = {
  research: { instruction: "You are the research specialist.", builtIn: true },
  garden: { instruction: "You are the garden specialist. Track what is planted.", builtIn: false },
} as const;

/** Writes the roster a cell had before jobs: one anchored conversation per specialist. */
async function seedWaveTwo(t: TestCell): Promise<void> {
  await t.cell.harness.commit(async (tx) => {
    const roster = await tx.doc(RosterDoc);
    for (const [name, { instruction, builtIn }] of Object.entries(WAVE_TWO)) {
      const anchorTaskId = await tx.createTask(Anchor, null, {
        ownership: { kind: "conversation" },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      });
      const child = await tx.createConversation({
        ownership: { kind: "task", taskId: anchorTaskId },
      });
      await configure(tx, child.id, {
        model: modelRef("anthropic/claude-haiku-4.5"),
        instructions: instruction,
      });
      roster.specialists[name] = {
        conversationId: child.id,
        instruction,
        anchorTaskId,
        builtIn,
        reported: [],
      };
    }
  }, BACKGROUND_CONTEXT);
}

describe("frozen specialists (AC-6)", () => {
  it("keeps the old conversations, migrates an added one, and finds old answers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    await seedWaveTwo(t);
    // The lead's history holds an answer a specialist gave before jobs.
    await (
      await t.cell.submit(
        "[handoff research answered] The Tuesday flight leaves at 9:40 from gate 12.",
        "old-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    const before = await t.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);

    await t.reopen();
    const after = await t.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    expect(after?.specialists).toEqual(before?.specialists);
    for (const [name, record] of Object.entries(after?.specialists ?? {})) {
      const conversation = await t.cell.harness.conversation(
        record.conversationId,
        BACKGROUND_CONTEXT,
      );
      expect((await conversation?.agent(BACKGROUND_CONTEXT))?.instructions).toBe(
        WAVE_TWO[name as keyof typeof WAVE_TWO].instruction,
      );
    }
    const templates = await t.cell.harness.snapshot(TemplatesDoc, BACKGROUND_CONTEXT);
    expect(templates?.custom).toEqual({
      garden: { instruction: WAVE_TWO.garden.instruction, tier: "cheap" },
    });
    const events = loggedEvents(log.mock.calls);
    expect(events.filter((e) => e.event === "template.migrated")).toEqual([
      expect.objectContaining({ name: "garden", start_tier: "cheap" }),
    ]);
    expect(events.filter((e) => e.event === "harness.opened").at(-1)).toMatchObject({
      templates_migrated: 1,
    });

    // A second reopen migrates nothing again.
    await t.reopen();
    expect(
      loggedEvents(log.mock.calls).filter((e) => e.event === "template.migrated"),
    ).toHaveLength(1);

    await (await t.cell.submit('CALL search_history {"query":"Tuesday flight"}', "new-1")).wait(
      BACKGROUND_CONTEXT,
    );
    expect((await toolResultsOf(t.cell.root)).at(-1)).toContain("9:40");
    const lead = t.gateway.requests.filter((r) => r.role === "lead").at(-1);
    expect(lead?.system).toContain("garden (cheap)");
    expect((await t.cell.status()).roles).toEqual(
      expect.arrayContaining(["lead", "research", "garden", "household"]),
    );
  });

  it("creates no specialist conversation for a new cell", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const roster = await test.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    expect(roster?.specialists ?? {}).toEqual({});
    expect((await test.cell.status()).roles).toEqual([
      "lead",
      "household",
      "research",
      "health",
      "developer",
    ]);
  });
});
