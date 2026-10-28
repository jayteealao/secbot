// The job gate: a job pauses before its next model step after three failing steps (AC-14), at its
// tier cap (AC-16), and never for a provider wait (AC-15). A paused job makes no request.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIER_MODELS } from "../src/release-defaults.ts";
import {
  createFauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { wakeNoticesOf } from "./job-helpers.ts";
import { ALERT_ENV, incidentStub } from "./outage-fixtures.ts";
import { jobResponder, startJobLine } from "./responders.ts";
import { INFLIGHT_402 } from "./stub-openrouter.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const job = async (t: TestCell, n = 1) => (await t.cell.board()).jobs[String(n)];

/** A job role that answers every request of its job with `answer`; the lead is scripted. */
const jobAnswers =
  (role: string, answer: (request: FauxRequest) => ReturnType<Responder>): Responder =>
  (request) =>
    request.role === role ? answer(request) : jobResponder(request);

/** The same failing call every time: a document name the household tools refuse. */
const failingRead = () =>
  fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
    stopReason: "toolUse",
  });

const startResearch = async (t: TestCell) =>
  (
    await t.cell.submit(
      startJobLine({ title: "flights", brief: "find flights", template: "research" }),
      "start-1",
    )
  ).wait(BACKGROUND_CONTEXT);

const researchRequests = (t: TestCell) =>
  t.gateway.requests.filter((request) => request.role === "research").length;

describe("the loop guard pauses a job (AC-14)", () => {
  it("pauses after the same failing tool call three times, wakes the lead once, and sends no fourth request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobAnswers("research", failingRead)) });
    const t = test;
    await startResearch(t);
    await until(async () => (await job(t))?.status === "paused");
    expect((await job(t))?.pause).toMatchObject({
      reason: "loop",
      detail: "same step failed 3 times",
    });
    await until(async () => (await wakeNoticesOf(t.cell.root)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(researchRequests(t)).toBe(3);
    expect(await wakeNoticesOf(t.cell.root)).toEqual([
      "[job 1 paused: same step failed 3 times; choose set_job or restart_job]",
    ]);
    expect((await job(t))?.result).toBeNull();
  });

  it("pauses after three empty replies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway(
        jobAnswers("research", () => fauxAssistantMessage([fauxText("")])),
      ),
    });
    const t = test;
    await startResearch(t);
    await until(async () => (await job(t))?.status === "paused");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await job(t))?.pause?.reason).toBe("loop");
    expect(researchRequests(t)).toBe(3);
    expect((await job(t))?.result).toBeNull();
  });

  it("stays paused with no request across a reopen of the cell", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobAnswers("research", failingRead)) });
    const t = test;
    await startResearch(t);
    await until(async () => (await job(t))?.status === "paused");
    await t.reopen();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await job(t))?.status).toBe("paused");
    expect(researchRequests(t)).toBe(3);
    expect(await wakeNoticesOf(t.cell.root)).toHaveLength(1);
  });
});

/** A cheap job that keeps working: every step calls a tool that succeeds, at $0.02 a step. */
const workingHousehold = () =>
  fauxAssistantMessage([fauxToolCall("search_history", { query: "milk" })], {
    stopReason: "toolUse",
  });

const CHEAP_STEP_USD = 0.02;
const pricedGateway = (respond: Responder) =>
  createFauxGateway(respond, {
    stepCostUsd: (modelId) => (modelId === TIER_MODELS.cheap ? CHEAP_STEP_USD : 0),
  });

const householdRequests = (t: TestCell) =>
  t.gateway.requests.filter((request) => request.role === "household").length;

const startHousehold = async (t: TestCell) =>
  (
    await t.cell.submit(
      startJobLine({ title: "groceries", brief: "plan the groceries", template: "household" }),
      "start-cheap",
    )
  ).wait(BACKGROUND_CONTEXT);

describe("the cap gate (AC-16)", () => {
  it("pauses a cheap job at $0.24 before the step that would pass $0.25", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: pricedGateway(jobAnswers("household", workingHousehold)),
    });
    const t = test;
    await startHousehold(t);
    await until(async () => (await job(t))?.status === "paused");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = await job(t);
    expect(row?.pause?.reason).toBe("cap");
    expect(row?.cap).toBe(0.25);
    expect(row?.cost).toBeCloseTo(0.24, 10);
    // Twelve steps of $0.02 ran; the thirteenth would pass the cap and was never sent.
    expect(householdRequests(t)).toBe(12);
    expect(await wakeNoticesOf(t.cell.root)).toEqual([
      "[job 1 paused: cap reached; choose set_job or restart_job]",
    ]);
  });

  it("stays paused at the cap with no request across a reopen", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: pricedGateway(jobAnswers("household", workingHousehold)),
    });
    const t = test;
    await startHousehold(t);
    await until(async () => (await job(t))?.status === "paused");
    await t.reopen();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await job(t))?.status).toBe("paused");
    expect(householdRequests(t)).toBe(12);
  });

  it("runs again after a raise to mid: the cap is $1 and the next request runs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: pricedGateway(jobAnswers("household", workingHousehold)),
    });
    const t = test;
    await startHousehold(t);
    await until(async () => (await job(t))?.status === "paused");
    expect(householdRequests(t)).toBe(12);
    await (await t.cell.submit('CALL set_job {"job":1,"tier":"mid"}', "raise-1")).wait(
      BACKGROUND_CONTEXT,
    );
    await until(() => householdRequests(t) > 12);
    expect(await job(t)).toMatchObject({
      tier: "mid",
      cap: 1,
      attempts: { raises: 1, restarts: 0 },
    });
  });
});

describe("provider waits are not failing steps (AC-15)", () => {
  it("waits through a 429 and an in-flight 402 without pausing, counting, or a credit alert", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let research = 0;
    const respond = jobAnswers("research", () => {
      research++;
      if (research === 1) {
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: '429 {"error":{"code":429,"message":"Rate limit exceeded"}}',
        });
      }
      if (research === 2) {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: INFLIGHT_402 });
      }
      return fauxAssistantMessage([fauxText("Three flights found.")]);
    });
    const { incidents, fetcher } = incidentStub();
    test = await openTestCell({
      gateway: createFauxGateway(respond),
      env: ALERT_ENV,
      fetch: fetcher,
    });
    const t = test;
    const statuses = new Set<string>();
    const watch = setInterval(() => {
      void job(t).then((row) => row !== undefined && statuses.add(row.status));
    }, 5);
    try {
      await startResearch(t);
      await until(async () => (await job(t))?.status === "done", 30_000);
    } finally {
      clearInterval(watch);
    }
    expect(research).toBe(3);
    expect(statuses.has("paused")).toBe(false);
    expect((await job(t))?.pause).toBeNull();
    expect((await job(t))?.result).toMatchObject({ kind: "routine", text: "Three flights found." });
    await t.cell.monitor.settled();
    expect(incidents).toHaveLength(0);
    const calls = loggedEvents(log.mock.calls).filter(
      (event) => event.event === "model.call" && event.role === "research",
    );
    expect(calls.map((event) => event.credit)).toEqual([false, false, false]);
  }, 40_000);
});
