// The fixture lookup tools of the test cell: `fixture_lookup` always fails the same way, so a job
// that calls it three times pauses through the loop guard; `fixture_slow_lookup` answers after its
// wait and ends early on an abort. A cell opened without the option has neither tool.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureToolsExtension, FIXTURE_LOOKUP_ERROR } from "../src/outside-tools.ts";
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
import { jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const job = async (t: TestCell, n = 1) => (await t.cell.board()).jobs[String(n)];

const jobAnswers =
  (role: string, answer: (request: FauxRequest) => ReturnType<Responder>): Responder =>
  (request) =>
    request.role === role ? answer(request) : jobResponder(request);

const startResearch = async (t: TestCell) =>
  (
    await t.cell.submit(
      startJobLine({ title: "lisbon", brief: "look up lisbon-7", template: "research" }),
      "start-1",
    )
  ).wait(BACKGROUND_CONTEXT);

/** The tool's `execute`, called directly with a context that carries `signal`. */
const slowTool = (slowMs: number) => {
  const tool = createFixtureToolsExtension({ slowMs }).tools?.find(
    (candidate) => candidate.name === "fixture_slow_lookup",
  );
  if (tool === undefined) throw new Error("no slow tool");
  return (signal?: AbortSignal) =>
    tool.execute(
      { topic: "flights" } as never,
      {} as never,
      {
        abortSignal: signal,
      } as unknown as Context,
    );
};

describe("fixture_lookup", () => {
  it("pauses a job that calls it three times with the loop reason", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: string[] = [];
    test = await openTestCell({
      fixtureTools: { slowMs: 50 },
      gateway: createFauxGateway(
        jobAnswers("research", (request) => {
          if (request.last?.role === "toolResult") seen.push(request.lastText);
          return fauxAssistantMessage([fauxToolCall("fixture_lookup", { id: "lisbon-7" })], {
            stopReason: "toolUse",
          });
        }),
      ),
    });
    const t = test;
    await startResearch(t);
    await until(async () => (await job(t))?.status === "paused");
    expect((await job(t))?.pause?.reason).toBe("loop");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const text of seen) expect(text).toBe(FIXTURE_LOOKUP_ERROR);
  });
});

describe("fixture_slow_lookup", () => {
  it("answers after its wait", async () => {
    const started = Date.now();
    const result = await slowTool(50)();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Lookup result for flights: three options found." },
    ]);
  });

  it("ends the call when the job is aborted during the wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const call = slowTool(60_000)(controller.signal);
    setTimeout(() => controller.abort(new Error("stopped")), 20);
    await expect(call).rejects.toThrow("stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("answers a job's call with the option, and the job finishes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      fixtureTools: { slowMs: 50 },
      gateway: createFauxGateway(
        jobAnswers("research", (request) =>
          request.last?.role === "toolResult"
            ? fauxAssistantMessage([fauxText(`done: ${request.lastText}`)])
            : fauxAssistantMessage([fauxToolCall("fixture_slow_lookup", { topic: "lisbon" })], {
                stopReason: "toolUse",
              }),
        ),
      ),
    });
    const t = test;
    await startResearch(t);
    await until(async () => (await job(t))?.result != null);
    expect((await job(t))?.result?.text).toContain(
      "Lookup result for lisbon: three options found.",
    );
  });
});

describe("without the option", () => {
  it("lists neither tool on a job's request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const offered: (readonly string[])[] = [];
    test = await openTestCell({
      gateway: createFauxGateway(
        jobAnswers("research", (request) => {
          offered.push(request.tools ?? []);
          return fauxAssistantMessage([fauxText("done")]);
        }),
      ),
    });
    const t = test;
    await startResearch(t);
    await until(() => offered.length > 0);
    expect(offered[0]).toContain("search_history");
    expect(offered[0]).not.toContain("fixture_lookup");
    expect(offered[0]).not.toContain("fixture_slow_lookup");
  });

  it("lists both with the option", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const offered: (readonly string[])[] = [];
    test = await openTestCell({
      fixtureTools: { slowMs: 50 },
      gateway: createFauxGateway(
        jobAnswers("research", (request) => {
          offered.push(request.tools ?? []);
          return fauxAssistantMessage([fauxText("done")]);
        }),
      ),
    });
    const t = test;
    await startResearch(t);
    await until(() => offered.length > 0);
    expect(offered[0]).toEqual(expect.arrayContaining(["fixture_lookup", "fixture_slow_lookup"]));
  });
});
