// The test cell's guard bench on the stand-in: the real harness and guard, the scripted lead, the
// decision model on the stub Decisions API (no outside call), and the scripted reviewer. The bench
// measures the guard's added time from its own guard.verdict events, never calls a chat route
// (so no live reviewer), and counts every call as a fallback when the decisions route fails.
import { FakeCelldStorage, until } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECISIONS_ROUTE,
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import {
  type BenchResults,
  GuardBenchCell,
  percentile,
  sampleOf,
  summarizeBench,
  WARMUP_CALLS,
} from "../src/guard-bench.ts";

const KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)

let stub: StubOpenRouter;
const benches: GuardBenchCell[] = [];
beforeEach(async () => {
  stub = await startStubOpenRouter();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.close();
  await stub.close();
  vi.restoreAllMocks();
});

const bench = () => {
  const cell = new GuardBenchCell(
    { storage: new FakeCelldStorage() },
    { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: stub.origin },
  );
  benches.push(cell);
  return cell;
};

const call = async (cell: GuardBenchCell, method: string, path: string) => {
  const response = await cell.fetch(new Request(`http://cell${path}`, { method }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

async function finished(cell: GuardBenchCell): Promise<BenchResults> {
  let state: Record<string, unknown> = {};
  await until(async () => {
    state = (await call(cell, "GET", "/lab/guard-bench-state")).body;
    return state.done === true;
  }, 30_000);
  return state.results as BenchResults;
}

describe("GuardBenchCell", () => {
  it("measures 20 permitted calls after the warm-up, from the decision model alone", async () => {
    stub.delayMs = 50;
    const cell = bench();
    expect(await call(cell, "POST", "/lab/guard-bench?calls=20")).toEqual({
      status: 200,
      body: { started: true, calls: 20, warmup: WARMUP_CALLS, adapter: "clef" },
    });
    // A second start while the run goes is refused.
    expect((await call(cell, "POST", "/lab/guard-bench?calls=20")).status).toBe(409);
    const results = await finished(cell);
    expect(results.measured).toBe(20);
    expect(results.timedOut).toBe(false);
    expect(results.p95Ms).toBeGreaterThanOrEqual(50);
    expect(results.p95Ms).toBeLessThan(500);
    expect(results.passedP95Ms).toBe(results.p95Ms);
    expect(results.ruleP95Ms).toBeLessThan(20);
    expect(results.marks).toBe(0);
    expect(results.fallbacks).toEqual({});
    expect(results.models).toEqual(["cloudflare/clef-20261001"]);
    expect(results.costUsd).toBeGreaterThan(0);
    // Every request went to the decisions route: the reviewer is scripted, never a chat call.
    expect(stub.seen.length).toBe(20 + WARMUP_CALLS);
    expect(stub.seen.every((request) => request.path === DECISIONS_ROUTE)).toBe(true);
  }, 60_000);

  it("counts every call as a fallback with its cause when the decisions route fails", async () => {
    stub.mode = 503;
    const cell = bench();
    await call(cell, "POST", "/lab/guard-bench?calls=10");
    const results = await finished(cell);
    expect(results.measured).toBe(10);
    expect(results.fallbacks).toEqual({ "http-503": 10 });
    expect(results.passedP95Ms).toBeNull();
    expect(results.models).toEqual([]);
  }, 60_000);

  it("measures the adapter it is given: Clef Flash and Jev reach the decisions route by their own model", async () => {
    for (const [adapter, model] of [
      ["clef-flash", "cloudflare/clef-flash"],
      ["jev", "typesafe/jev-1.13"],
    ] as const) {
      stub.seen.splice(0);
      const cell = bench();
      expect(
        (await call(cell, "POST", `/lab/guard-bench?calls=5&adapter=${adapter}`)).body,
      ).toEqual({
        started: true,
        calls: 5,
        warmup: WARMUP_CALLS,
        adapter,
      });
      const results = await finished(cell);
      expect(results.measured).toBe(5);
      expect(results.models).toEqual([`${model}-20261001`]);
      const bodies = stub.seen.map((request) => request.body as { model?: string });
      expect(new Set(bodies.map((body) => body.model))).toEqual(new Set([model]));
    }
  }, 60_000);

  it("refuses an unknown adapter", async () => {
    const cell = bench();
    for (const adapter of ["clef-pro", "", "CLEF"]) {
      expect((await call(cell, "POST", `/lab/guard-bench?calls=5&adapter=${adapter}`)).status).toBe(
        400,
      );
    }
  });

  it("refuses a calls value outside 1-200 and answers an unknown route with 404", async () => {
    const cell = bench();
    for (const calls of ["0", "201", "x", "-1", "1e2"]) {
      expect((await call(cell, "POST", `/lab/guard-bench?calls=${calls}`)).status).toBe(400);
    }
    expect((await call(cell, "GET", "/lab/guard-bench-state")).body).toEqual({
      done: false,
      measured: 0,
      started: false,
    });
    expect((await call(cell, "GET", "/lab/other")).status).toBe(404);
  });
});

describe("the bench numbers", () => {
  it("takes nearest-rank percentiles and sums by cause, model, and cost", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(95);
    const sample = (ms: number, decision: string, fallback: string | null = null) =>
      sampleOf({
        duration_ms: ms,
        rule_ms: 0.01,
        verdict: "allowed",
        decision,
        decision_model: decision === "fallback" ? null : "cloudflare/clef-x",
        fallback,
        cost_usd: 0.0001,
      });
    const results = summarizeBench([
      sample(100, "pass"),
      sample(200, "would mark"),
      sample(1600, "fallback", "timeout"),
    ]);
    expect(results).toMatchObject({
      measured: 3,
      p50Ms: 200,
      p95Ms: 1600,
      passedP95Ms: 100,
      marks: 1,
      fallbacks: { timeout: 1 },
      models: ["cloudflare/clef-x"],
      costUsd: 0.0003,
    });
  });
});
