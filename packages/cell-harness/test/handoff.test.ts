// Handoff wiring (the lead model's own tool call carries the brief; the answer returns as a
// follow-up), and a restart after the specialist finished reports the answer exactly once.
// Whether the real lead model decides to hand off is checked live on the test cell.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leadMessageOf } from "../src/delivery.ts";
import { RosterDoc } from "../src/docs.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { BRIEF, handoffResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

async function leadEntries(t: TestCell): Promise<EntryRecord[]> {
  const page = await t.cell.root.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  return [...page.items].reverse();
}

const followups = async (t: TestCell) =>
  (await leadEntries(t)).map(leadMessageOf).filter((message) => message?.kind === "followup");

describe("hand-off", () => {
  it("delivers the brief the lead model wrote and returns the answer as a follow-up", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(handoffResponder) });
    const t = test;
    await (await t.cell.submit("Find out about fasting for me", "req-1")).wait(BACKGROUND_CONTEXT);
    await until(async () =>
      (await leadEntries(t)).some((entry) =>
        leadMessageOf(entry)?.text.startsWith("Research says"),
      ),
    );

    const research = t.gateway.requests.filter((request) => request.role === "research");
    expect(research[0]?.lastText).toBe(BRIEF);
    const messages = (await leadEntries(t)).map(leadMessageOf).filter((m) => m !== undefined);
    expect(messages.map((m) => m.kind)).toEqual(["answer", "followup", "answer"]);
    expect(messages[1]).toMatchObject({
      from: "research",
      text: "research finding: evidence is mixed.",
    });

    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines.find((line) => line.event === "handoff.started")).toMatchObject({
      specialist: "research",
      brief_chars: BRIEF.length,
    });
    expect(lines.find((line) => line.event === "handoff.reported")).toMatchObject({
      outcome: "reported",
    });
    expect(JSON.stringify(lines)).not.toContain(BRIEF);
  });

  it("refuses a hand-off to a specialist that does not exist", async () => {
    const gateway = createFauxGateway((request) =>
      request.role === "lead" && request.last?.role !== "toolResult"
        ? fauxAssistantMessage([fauxToolCall("handoff", { specialist: "astrology", brief: "x" })], {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText(request.lastText)]),
    );
    test = await openTestCell({ gateway });
    await (await test.cell.submit("hi", "req-1")).wait(BACKGROUND_CONTEXT);
    const toolResult = gateway.requests.at(-1)?.lastText ?? "";
    expect(toolResult).toContain("No specialist named astrology");
  });

  it("reports the answer exactly once across a restart after the specialist finished", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(handoffResponder) });
    const t = test;
    await (await t.cell.submit("Find out about fasting for me", "req-1")).wait(BACKGROUND_CONTEXT);
    const roster = await t.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT);
    const researchId = roster?.specialists.research?.conversationId;
    if (researchId === undefined) throw new Error("no research specialist");
    // Close as soon as the specialist's answer is committed, before or after the report.
    await until(async () => {
      const research = await t.cell.harness.conversation(researchId, BACKGROUND_CONTEXT);
      const page = await research?.entries({}, 10, undefined, BACKGROUND_CONTEXT);
      return (page?.items ?? []).some((entry) => entry.kind === "pi.assistant");
    });
    await t.reopen();
    await until(async () => (await followups(t)).length > 0);
    await until(async () =>
      (await leadEntries(t)).some((entry) =>
        leadMessageOf(entry)?.text.startsWith("Research says"),
      ),
    );
    expect(await followups(t)).toHaveLength(1);

    // Another restart after everything settled reports nothing again.
    await t.reopen();
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await followups(t)).toHaveLength(1);
    expect(t.gateway.requests.filter((request) => request.role === "research")).toHaveLength(1);
  });
});
