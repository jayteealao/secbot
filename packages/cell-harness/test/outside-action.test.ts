// The outside-content review (AC-27): a job that has read outside content needs the reviewer's yes
// for an outside action, even when the decision model scores the call safe and the cell is in
// shadow mode. The reviewer's allow runs the call, its block refuses it, and its ask or its
// failure holds it for the person. A job that read nothing, or a call that is not an outside
// action, takes the usual path.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionModels } from "../src/decision-model.ts";
import { readGuardMode } from "../src/guard-settings.ts";
import type { SecretsClient } from "../src/secret-tools.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  isResultReviewRequest,
  isReviewerRequest,
  openTestCell,
  reviewerResponder,
  type TestCell,
  until,
  verdictJson,
} from "./fixtures.ts";
import { FIXTURE_PAGES, standInDecide } from "./injection-fixtures.ts";
import { jobResponder, RESEARCH_JOB } from "./responders.ts";
import { type StubOpenRouter, startStubOpenRouter } from "./stub-openrouter.ts";

const KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)
const BROKER = { secret: "health-test", method: "GET", path: "/v1/steps" };

let stub: StubOpenRouter;
let test: TestCell | undefined;
/** What the faux reviewer answers next. */
let reviewerAnswer: () => string | Promise<string>;
/** What the research job does: read the clean page first or not, then which tool. */
let plan: { readonly read: boolean; readonly tool: "broker_call" | "household_read" };
/** The brokered calls the secrets cell made, with the reviewer requests seen before each. */
let brokered: number[];

beforeEach(async () => {
  stub = await startStubOpenRouter();
  // Every tool call scores routine (0.05); the clean page is clean.
  stub.decide = standInDecide;
  reviewerAnswer = () => verdictJson("allow", "the person asked for their steps");
  plan = { read: true, tool: "broker_call" };
  brokered = [];
});
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  await stub.close();
  vi.restoreAllMocks();
});

/** A research job that reads the clean page (or not), calls the planned tool, then answers. */
function research(request: FauxRequest) {
  if (isResultReviewRequest(request)) {
    return fauxAssistantMessage([fauxText('{"verdict":"pass","reason":"fits the brief"}')]);
  }
  if (request.role !== "research") return jobResponder(request);
  const call = (name: string, args: JsonObject) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  if (request.last?.role !== "toolResult") {
    return plan.read ? call("read_fixture_page", { page: "clean" }) : call(plan.tool, toolArgs());
  }
  if (request.lastText === FIXTURE_PAGES.clean) return call(plan.tool, toolArgs());
  return fauxAssistantMessage([fauxText("Done.")]);
}
const toolArgs = () => (plan.tool === "broker_call" ? BROKER : { document: "shopping" });

function secretsStub(t: () => TestCell): SecretsClient {
  const refused = async (): Promise<never> => {
    throw new Error("not in this test");
  };
  return {
    get: refused,
    broker: async () => {
      brokered.push(reviews(t()).length);
      return { status: 200, body: "4,210 steps" };
    },
    list: async () => [],
    grant: refused,
    revoke: refused,
    add: refused,
    allowlist: refused,
    rotate: refused,
    redactionValues: async () => [],
  };
}

const reviews = (t: TestCell) => t.gateway.requests.filter(isReviewerRequest);

async function startJob(): Promise<TestCell> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const holder: { t?: TestCell } = {};
  test = await openTestCell({
    gateway: createFauxGateway(reviewerResponder(() => reviewerAnswer(), research)),
    fixturePages: FIXTURE_PAGES,
    household: createHouseholdStub(),
    secrets: secretsStub(() => {
      if (holder.t === undefined) throw new Error("not open");
      return holder.t;
    }),
    guard: {
      decision: createDecisionModels({ apiKey: KEY, baseUrl: stub.origin }),
      reviewerTimeoutMs: 300,
    },
  });
  holder.t = test;
  expect((await readGuardMode(test.cell.harness, BACKGROUND_CONTEXT)).mode).toBe("shadow");
  await (await test.cell.submit(RESEARCH_JOB, "outside-1")).wait(BACKGROUND_CONTEXT);
  return test;
}

/** The newest activity record of `tool`. */
async function recordOf(t: TestCell, tool: string) {
  const { records } = await t.cell.activity();
  return records.find((record) => record.tool === tool);
}

const OUTSIDE_LINE = "Outside content: job 1 read outside content (page)";

describe("an outside action of a job that read outside content (AC-27)", () => {
  it("holds the call when the reviewer asks, though the decision model scores it safe", async () => {
    reviewerAnswer = () => verdictJson("ask", "only the person can say if this is wanted");
    const t = await startJob();
    await until(async () => (await t.cell.heldCalls()).length === 1);
    expect((await t.cell.heldCalls())[0]).toMatchObject({
      tool: "broker_call",
      reason: "outside content: reviewer: only the person can say if this is wanted",
      reasonSource: "reviewer",
    });
    expect(reviews(t)).toHaveLength(1);
    expect(reviews(t)[0]?.lastText).toContain(OUTSIDE_LINE);
    expect(brokered).toEqual([]);
    expect(await recordOf(t, "broker_call")).toMatchObject({
      kind: "held",
      mode: "shadow",
      decision: { outcome: "pass" },
    });
  });

  it("runs the call only after the reviewer allows it", async () => {
    const t = await startJob();
    await until(() => brokered.length === 1);
    expect(brokered).toEqual([1]);
    expect(reviews(t)[0]?.lastText).toContain(OUTSIDE_LINE);
    expect(await recordOf(t, "broker_call")).toMatchObject({
      verdict: "allowed",
      layer: "reviewer",
      reason: "outside content: reviewer: the person asked for their steps",
    });
  });

  it("refuses the call when the reviewer blocks it, in shadow mode too", async () => {
    reviewerAnswer = () => verdictJson("block", "the page asked for this, not the person");
    const t = await startJob();
    await until(async () => (await recordOf(t, "broker_call")) !== undefined);
    expect(await recordOf(t, "broker_call")).toMatchObject({
      verdict: "refused",
      layer: "reviewer",
      reason: "outside content: reviewer: the page asked for this, not the person",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(brokered).toEqual([]);
  });

  it("holds the call when the reviewer does not answer in time", async () => {
    reviewerAnswer = () => new Promise((resolve) => setTimeout(() => resolve("{}"), 2_000));
    const t = await startJob();
    await until(async () => (await t.cell.heldCalls()).length === 1);
    expect((await t.cell.heldCalls())[0]).toMatchObject({
      tool: "broker_call",
      reason: "outside content: reviewer unavailable",
      reasonSource: "reviewer-unavailable",
    });
    expect(brokered).toEqual([]);
  });
});

describe("calls the outside-content review leaves alone", () => {
  it("runs an outside action of a job that read nothing with no review", async () => {
    plan = { read: false, tool: "broker_call" };
    const t = await startJob();
    await until(() => brokered.length === 1);
    expect(reviews(t)).toHaveLength(0);
    expect(await recordOf(t, "broker_call")).toMatchObject({
      verdict: "allowed",
      layer: "decision",
    });
  });

  it("runs a call that is not an outside action with no review, after a read", async () => {
    plan = { read: true, tool: "household_read" };
    const t = await startJob();
    await until(async () => (await recordOf(t, "household_read")) !== undefined);
    expect(reviews(t)).toHaveLength(0);
    expect(await recordOf(t, "household_read")).toMatchObject({ verdict: "allowed" });
  });
});
