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
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";

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
