// Escalation: the lead chooses a raise (set_job) or a restart (restart_job) in either order; code
// allows one of each, refuses a third move, and then the job ends failed with a question to the
// person (C3, D-035, RIM-5: the tests assert bounds and outcomes, never one sequence).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc } from "../src/docs.ts";
import {
  failingResearch,
  job,
  leadCalls,
  researchRequests,
  startPausedJob,
} from "./escalation-helpers.ts";
import {
  addJobSpend,
  createFauxGateway,
  fauxAssistantMessage,
  fauxToolCall,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("bounded raises in set_job", () => {
  it("resumes a paused job on a raise, counts it, and the job's new steps run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await startPausedJob(t);
    expect(researchRequests(t)).toBe(3);
    const said = await leadCalls(t, "set_job", { job: 1, tier: "frontier" });
    expect(said).toContain("job 1 now runs on frontier (cap $3)");
    // The loop guard counts again from the raise: three new failing steps pause it again.
    await until(async () => researchRequests(t) === 6);
    await until(async () => (await job(t))?.status === "paused");
    expect(await job(t)).toMatchObject({
      tier: "frontier",
      cap: 3,
      attempts: { raises: 1, restarts: 0 },
      pause: { reason: "loop" },
    });
  });

  it("refuses a second raise while the restart is left, and changes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await startPausedJob(t);
    await leadCalls(t, "set_job", { job: 1, effort: "high" });
    await until(async () => (await job(t))?.status === "paused" && researchRequests(t) === 6);
    const refused = await leadCalls(t, "set_job", { job: 1, tier: "frontier" });
    expect(refused).toBe("Refused: job 1 has used its raise; restart_job is left.");
    expect(await job(t)).toMatchObject({
      tier: "mid",
      status: "paused",
      attempts: { raises: 1, restarts: 0 },
    });
  });

  it("lets a lower or equal move go free", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await startPausedJob(t);
    await leadCalls(t, "set_job", { job: 1, tier: "cheap", effort: "low" });
    expect((await job(t))?.attempts).toEqual({ raises: 0, restarts: 0 });
    expect((await job(t))?.tier).toBe("cheap");
  });

  it("ends the job failed with a question to the person when the raise and restart are used", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await startPausedJob(t);
    await t.cell.harness.commit(async (tx) => {
      const row = (await tx.doc(JobBoardDoc)).jobs["1"];
      if (row !== undefined) row.attempts = { raises: 1, restarts: 1 };
    }, BACKGROUND_CONTEXT);
    const refused = await leadCalls(t, "set_job", { job: 1, tier: "frontier" });
    expect(refused).toBe(
      "Refused: job 1 has used its raise and its restart. It has stopped; ask the person in your own words what to do — the chat adds the /answer line.",
    );
    await until(async () => (await job(t))?.status === "failed");
    expect(await job(t)).toMatchObject({
      tier: "mid",
      result: { kind: "failure", text: "raise and restart used" },
      question: { from: "escalation", toPerson: true, answer: null },
    });
    const requests = researchRequests(t);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(researchRequests(t)).toBe(requests);
  });
});

/** Waits until job 1 is paused again after `requests` research requests in all. */
const pausedAfter = async (t: TestCell, requests: number) => {
  await until(async () => researchRequests(t) === requests);
  await until(async () => (await job(t))?.status === "paused");
};

const expectExhausted = async (t: TestCell) => {
  await until(async () => (await job(t))?.status === "failed");
  expect(await job(t)).toMatchObject({
    attempts: { raises: 1, restarts: 1 },
    result: { kind: "failure", text: "raise and restart used" },
    question: { from: "escalation", toPerson: true, answer: null },
  });
};

describe("bounds over both orders (AC-13)", () => {
  const EXHAUSTED_LINE =
    "Refused: job 1 has used its raise and its restart. It has stopped; ask the person in your own words what to do — the chat adds the /answer line.";

  for (const third of [
    { tool: "restart_job", args: { job: 1, note: "third try" } },
    { tool: "set_job", args: { job: 1, effort: "high" } },
  ]) {
    it(`order A: restart, then raise; a third move (${third.tool}) is refused and asks the person`, async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
      const t = test;
      await startPausedJob(t);
      expect(
        await leadCalls(t, "restart_job", { job: 1, note: "the list name was wrong" }),
      ).toContain("restarts with a fresh subagent");
      await pausedAfter(t, 6);
      expect(await leadCalls(t, "set_job", { job: 1, tier: "frontier" })).toContain(
        "It was paused and runs again.",
      );
      await pausedAfter(t, 9);
      expect(await leadCalls(t, third.tool, third.args)).toBe(EXHAUSTED_LINE);
      await expectExhausted(t);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(researchRequests(t)).toBe(9);
    });
  }

  it("order B: raise, then restart; a third move is refused and asks the person", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await startPausedJob(t);
    expect(await leadCalls(t, "set_job", { job: 1, effort: "high" })).toContain("runs again");
    await pausedAfter(t, 6);
    expect(await leadCalls(t, "restart_job", { job: 1, note: "effort did not help" })).toContain(
      "restarts with a fresh subagent",
    );
    await pausedAfter(t, 9);
    expect(await leadCalls(t, "set_job", { job: 1, tier: "frontier" })).toBe(EXHAUSTED_LINE);
    await expectExhausted(t);
  });

  it("a cap pause after both moves also ends in the question to the person", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // A job that keeps working: no failing step, so only the cap can pause it.
    test = await openTestCell({
      gateway: createFauxGateway((request) =>
        request.role === "research"
          ? fauxAssistantMessage([fauxToolCall("search_history", { query: "flights" })], {
              stopReason: "toolUse",
            })
          : jobResponder(request),
      ),
    });
    const t = test;
    await (
      await t.cell.submit(
        startJobLine({ title: "flights", brief: "find flights", template: "research" }),
        "start-working",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => researchRequests(t) > 2);
    await leadCalls(t, "restart_job", { job: 1, note: "start over" });
    await until(async () => (await job(t))?.conversationId != null && researchRequests(t) > 5);
    await leadCalls(t, "set_job", { job: 1, tier: "frontier" });
    expect((await job(t))?.attempts).toEqual({ raises: 1, restarts: 1 });
    // The job's spend reaches its $3 cap: the gate pauses it before its next step.
    await addJobSpend(t.cell, 1, 3);
    await until(async () => (await job(t))?.status === "paused");
    expect((await job(t))?.pause?.reason).toBe("cap");
    expect(await leadCalls(t, "restart_job", { job: 1, note: "again" })).toBe(EXHAUSTED_LINE);
    await expectExhausted(t);
  });
});
