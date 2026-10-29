// The shared-job stand-in's own checks, before the end-to-end proofs lean on it: on one fleet and
// on two, each person reaches their own cell with their own device, and a lead turn costs money.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type FauxRequest, until } from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatSession,
  OFFER_ASK,
  relayText,
  type SharedSetup,
  sharedResponder,
  sharedSetup,
} from "./shared-setup.ts";

let s: SharedSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

describe.each([1, 2] as const)("the shared-job stand-in on %i fleet(s)", (fleets) => {
  it("serves secbot jobs to each person with their own device", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets });
    for (const person of ["owner", "second"]) {
      const ran = await s.secbotAs(person, ["jobs"]);
      expect(ran.err).toBe("");
      expect(ran.code).toBe(0);
      expect(ran.out).toContain(`JOBS  ${person}`);
    }
  });

  it("books a lead turn's cost on the month", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets });
    expect((await s.secbotAs("second", ["jobs"])).code).toBe(0);
    const harness = s.harness("second");
    await (await harness.submit("hello there", "smoke-1")).wait(BACKGROUND_CONTEXT);
    await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
    await until(async () => (await harness.cost()).spentUsd > 0);
    expect((await harness.cost()).spentUsd).toBeGreaterThan(0);
  });
});

describe("a used-up budget and a lost answer on the stand-in", () => {
  it("budgetOver makes the household read the person as used up", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets: 2 });
    for (const person of ["owner", "second"])
      expect((await s.secbotAs(person, ["jobs"])).code).toBe(0);
    const household = s.household;
    if (household === undefined) throw new Error("no household cell");
    const report = async (person: string) =>
      (await household.budget()).reports.find((each) => each.cell === person);
    await s.budgetOver("owner");
    const over = await report("owner");
    expect(over?.spentUsd).toBeGreaterThanOrEqual(over?.limitUsd ?? Number.POSITIVE_INFINITY);
    await s.budgetOver("second");
    const second = await report("second");
    expect(second?.spentUsd).toBeGreaterThanOrEqual(second?.limitUsd ?? Number.POSITIVE_INFINITY);
    await s.budgetBack("owner");
    const back = await report("owner");
    expect(back?.spentUsd).toBeLessThan(back?.limitUsd ?? 0);
  });

  it("dropNextAnswer loses one answer; the same ops go again and apply once", {
    timeout: 60_000,
  }, async () => {
    quiet();
    s = await sharedSetup({ fleets: 2 });
    for (const person of ["owner", "second"])
      expect((await s.secbotAs(person, ["jobs"])).code).toBe(0);
    const owner = s.harness("owner");
    s.dropNextAnswer("owner");
    await (await owner.submit("SHARE plan the May trip", "drop-1")).wait(BACKGROUND_CONTEXT);
    const setup = s;
    await until(() => setup.crossFleetSyncs.some((sync) => sync.status === 503));
    const lost = setup.crossFleetSyncs.find((sync) => sync.status === 503);
    expect(lost?.opIds.length).toBeGreaterThan(0);
    const outbox = async () =>
      Object.values((await owner.board()).jobs).flatMap((row) =>
        (row.shared?.outbox ?? []).map((op) => op.opId),
      );
    expect(await outbox()).toEqual(lost?.opIds);
    expect((await owner.syncShared()).outcome).toBe("ok");
    const again = setup.crossFleetSyncs.find(
      (sync) => sync.status === 200 && sync.opIds.join() === lost?.opIds.join(),
    );
    expect(again).toBeDefined();
    expect(await outbox()).toEqual([]);
    const household = (await setup.household?.jobs())?.rows ?? [];
    expect(household).toHaveLength(1);
  });
});

/** A faux lead request whose newest message is `text` (a tool's result when `tool` is given). */
const leadRequest = (text: string, tool?: string): FauxRequest => ({
  system: "You are the lead agent. Give the offer with offer_shared and share the cost.",
  last: (tool === undefined
    ? { role: "user", content: text, timestamp: 0 }
    : {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: tool,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
      }) as FauxRequest["last"],
  lastText: text,
  modelId: "faux",
  role: "lead",
});

const said = (message: AssistantMessage) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
const called = (message: AssistantMessage) =>
  message.content.flatMap((part) =>
    part.type === "toolCall" ? [{ name: part.name, arguments: part.arguments }] : [],
  );

describe("the scripted leads of the shared-job stand-in", () => {
  it("relays a pulled result in its own words, not the offer ask", async () => {
    const answer = await sharedResponder(
      leadRequest(
        'job 4 "plan the May trip" (routine), brief: plan the May trip, for both of us.\nResult:\nPlan: go.',
        "job_result",
      ),
    );
    expect(said(answer)).toEqual([relayText("Plan: go.")]);
    expect(said(answer)).not.toContain(OFFER_ASK);
  });

  it("asks after giving an offer and says it asked after proposing", async () => {
    const offered = await sharedResponder(
      leadRequest(
        'Ask the person in your own words now; the chat adds "[ job 2 shared ]" and their /join or /decline goes to the household.',
        "offer_shared",
      ),
    );
    expect(said(offered)).toEqual([OFFER_ASK]);
    const proposed = await sharedResponder(
      leadRequest(
        "job 3 waits for second to agree to share the cost; tell the person you asked them.",
        "propose_shared_job",
      ),
    );
    expect(said(proposed)).toEqual(["I asked second to share it."]);
  });

  it("pulls a failure or risky result once when woken", async () => {
    for (const kind of ["failure", "risky"]) {
      const answer = await sharedResponder(leadRequest(`[job 5 ${kind}: pull it with job_result]`));
      expect(called(answer)).toEqual([{ name: "job_result", arguments: { job: 5 } }]);
    }
    const plain = await sharedResponder(leadRequest('CALL job_result {"job":5}'));
    expect(called(plain)).toEqual([{ name: "job_result", arguments: { job: 5 } }]);
  });
});

describe("a scripted secbot chat session on the stand-in", () => {
  it("prints the lead's answer; a look-alike join is not sent", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets: 2 });
    expect((await s.secbotAs("second", ["jobs"])).code).toBe(0);
    const chat = chatSession(s, "second");
    await chat.open();
    await chat.say("hello there");
    await until(() => chat.out().includes("> hello there\nok"));
    const before = s.gateway.requests.length;
    await chat.say("/join x");
    expect(chat.err()).toBe("not sent: answer with /join <#> or /decline <#>\n");
    expect(chat.routed()).toBe(0);
    expect(s.gateway.requests.length).toBe(before);
    await chat.close();
  });
});
