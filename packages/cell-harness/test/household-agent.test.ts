// The household agent: a proposed job starts only on the other person's yes, runs on the
// household template's tier with the household agent's rules, and stores its answer with no word
// to the root conversation; a call to any tool outside its two is refused; the heartbeat keeps its
// wake time.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc } from "../src/docs.ts";
import {
  HOUSEHOLD_TOOL_REFUSAL,
  type HouseholdAgent,
  openHouseholdAgent,
} from "../src/household-agent.ts";
import { TIER_MODELS } from "../src/release-defaults.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  FakeCelldStorage,
  type FauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
  resultReviewer,
  until,
} from "./fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { answer, propose } from "./shared-helpers.ts";

let agent: HouseholdAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
  vi.restoreAllMocks();
});

async function open(respond: Responder): Promise<{ agent: HouseholdAgent; gateway: FauxGateway }> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const gateway = createFauxGateway(resultReviewer(respond));
  agent = await openHouseholdAgent({
    cell: "household",
    storage: new FakeCelldStorage(),
    env: {},
    now: () => Date.now(),
    onReport: () => {},
    onWakeChange: () => {},
    models: gateway.models,
    budgets: async () => [],
    household: createHouseholdStub(),
    persons: ["owner", "second"],
  });
  return { agent, gateway };
}

const plansForBoth: Responder = () =>
  fauxAssistantMessage([fauxText("Plan for both: fly on the 3rd, back on the 10th.")]);

const row = async (a: HouseholdAgent, n: number) =>
  (await a.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs[String(n)];

describe("the household agent", () => {
  it("runs a joined job on the household tier with its own rules, and tells no conversation", async () => {
    const { agent: a, gateway } = await open(plansForBoth);
    const proposed = await a.exchange({ person: "owner", ops: [propose()] });
    expect(proposed.acks[0]?.household).toBe(1);
    expect(proposed.rows[0]).toMatchObject({ consent: "asked", status: "queued" });
    expect(gateway.requests).toEqual([]);
    const joined = await a.exchange({ person: "second", ops: [answer(1, true)] });
    expect(joined.rows[0]).toMatchObject({ consent: "joined", local: 7 });
    await until(async () => (await row(a, 1))?.status === "done");
    expect((await row(a, 1))?.result?.text).toBe(
      "Plan for both: fly on the 3rd, back on the 10th.",
    );
    const asked = gateway.requests.filter((request) => request.system.includes("household agent"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((request) => request.modelId === TIER_MODELS.cheap)).toBe(true);
    const root = await a.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    expect((await root?.entries({}, 20, undefined, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
    const relayed = await a.exchange({ person: "owner", ops: [] });
    expect(relayed.rows[0]?.result).toMatchObject({
      kind: "routine",
      text: "Plan for both: fly on the 3rd, back on the 10th.",
    });
  });

  it("refuses any tool outside its two household tools", async () => {
    const triesToStartWork: Responder = (request) =>
      request.last?.role === "toolResult"
        ? fauxAssistantMessage([fauxText("I cannot start other work; here is the plan.")])
        : fauxAssistantMessage(
            [fauxToolCall("start_job", { title: "more", brief: "more", template: "research" })],
            { stopReason: "toolUse" },
          );
    const { agent: a } = await open(triesToStartWork);
    await a.exchange({ person: "owner", ops: [propose()] });
    await a.exchange({ person: "second", ops: [answer(1, true)] });
    await until(async () => (await row(a, 1))?.status === "done");
    const id = (await row(a, 1))?.conversationId;
    if (id === null || id === undefined) throw new Error("no job conversation");
    const conversation = await a.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("no conversation");
    const results = await toolResultsOf(conversation);
    expect(results.length).toBe(1);
    // Not on the job's list, so the harness refuses it before any check; a listed tool outside
    // the two would get the household check's refusal.
    expect(results[0]).toContain("Tool start_job is not available");
    expect(HOUSEHOLD_TOOL_REFUSAL).toContain(
      "household_read, household_change, and search_old_job",
    );
  });

  it("keeps the heartbeat routine's wake time", async () => {
    const { agent: a } = await open(plansForBoth);
    const { summary } = await a.wakes();
    expect(JSON.stringify(summary)).toContain("heartbeat");
  });
});
