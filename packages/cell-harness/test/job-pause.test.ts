// The job gate: a job pauses before its next model step after three failing steps (AC-14), at its
// tier cap (AC-16), and never for a provider wait (AC-15). A paused job makes no request.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { wakeNoticesOf } from "./job-helpers.ts";
import { jobResponder, startJobLine } from "./responders.ts";

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
