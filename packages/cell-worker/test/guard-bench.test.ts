// The test cell's guard bench on the stand-in: the real harness and guard, the scripted lead, the
// decision model on the stub Decisions API (no outside call), and the scripted reviewer. The bench
// measures the guard's added time from its own guard.verdict events, never calls a chat route
// (so no live reviewer), and counts every call as a fallback when the decisions route fails. Its
// examples run makes the threshold examples' calls and judges each score on the release threshold.
import { onLogEvent } from "@secbot/cell-harness";
import { FakeCelldStorage, until } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECISIONS_ROUTE,
  riskyAt,
  routineAt,
  type StubDecision,
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import {
  type BenchEnv,
  type BenchOptions,
  type BenchResults,
  benchExamples,
  type ExampleResults,
  GuardBenchCell,
  percentile,
  sampleOf,
  summarizeBench,
  summarizeExamples,
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

const bench = (
  storage = new FakeCelldStorage(),
  options: BenchOptions = {},
  env: Record<string, string> = {},
) => {
  const cell = new GuardBenchCell(
    { storage },
    { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: stub.origin, ...env } as BenchEnv,
    options,
  );
  benches.push(cell);
  return cell;
};

/** The stub answers the n-th decision request with `answers[n mod length]` (calls are in order). */
function answerInOrder(answers: readonly StubDecision[]): void {
  let next = 0;
  stub.decide = () => answers[next++ % answers.length] ?? routineAt(0.05);
}

/** Risky examples at 0.8 and routine ones at 0.1, with `override` by example index. */
const scripted = (override: Record<number, StubDecision> = {}) =>
  benchExamples().map(
    (example, index) =>
      override[index] ?? (example.expected === "mark" ? riskyAt(0.8) : routineAt(0.1)),
  );

async function examplesFinished(cell: GuardBenchCell): Promise<ExampleResults> {
  let state: Record<string, unknown> = {};
  await until(async () => {
    state = (await call(cell, "GET", "/lab/guard-bench-state")).body;
    return state.done === true;
  }, 30_000);
  expect(state.kind).toBe("examples");
  return state.results as ExampleResults;
}

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
      body: { started: true, calls: 20, warmup: WARMUP_CALLS, adapter: "jev" },
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
    expect(results.models).toEqual(["typesafe/jev-1.13-20261001"]);
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

  it("measures the adapter it is given: Clef Flash and Clef reach the decisions route by their own model", async () => {
    for (const [adapter, model] of [
      ["clef-flash", "cloudflare/clef-flash"],
      ["clef", "cloudflare/clef"],
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

  it("runs every live example twice and passes when each risky one marks and no routine one does", async () => {
    answerInOrder(scripted());
    const cell = bench();
    const started = await call(cell, "POST", "/lab/guard-bench?examples=1&adapter=jev");
    expect(started).toEqual({
      status: 200,
      body: { started: true, kind: "examples", examples: 11, repeat: 2, calls: 22, adapter: "jev" },
    });
    const results = await examplesFinished(cell);
    expect(results.calls).toBe(22);
    expect(results.allOk).toBe(true);
    expect(results.models).toEqual(["typesafe/jev-1.13-20261001"]);
    expect(results.fallbacks).toEqual({});
    // The tool no agent has is threshold logic only; every other tool has its examples.
    expect(results.examples.map((example) => example.tool)).not.toContain("new_tool");
    const reminder = results.examples.find((example) => example.name.includes("card number"));
    expect(reminder).toMatchObject({
      tool: "set_reminder",
      expected: "mark",
      threshold: 0.5,
      marked: [true, true],
      ok: true,
    });
    expect(reminder?.scores.map((score) => score?.toFixed(2))).toEqual(["0.80", "0.80"]);
    // Every request went to the decisions route, by the chosen model.
    expect(stub.seen.every((request) => request.path === DECISIONS_ROUTE)).toBe(true);
    expect(stub.seen).toHaveLength(22);
  }, 60_000);

  it("fails the run and names the example when one risky example scores under its threshold", async () => {
    const examples = benchExamples();
    const missed = examples.findIndex((example) => example.name.includes("bank details"));
    answerInOrder(scripted({ [missed]: riskyAt(0.2) }));
    const cell = bench();
    await call(cell, "POST", "/lab/guard-bench?examples=1&repeat=1");
    const results = await examplesFinished(cell);
    expect(results.allOk).toBe(false);
    expect(results.examples.filter((example) => !example.ok)).toEqual([
      expect.objectContaining({ tool: "handoff", expected: "mark", marked: [false] }),
    ]);
  }, 60_000);

  it("never passes when the decisions route fails: every call is a fallback", async () => {
    stub.mode = 503;
    const cell = bench();
    await call(cell, "POST", "/lab/guard-bench?examples=1&repeat=1");
    const results = await examplesFinished(cell);
    expect(results.allOk).toBe(false);
    expect(results.fallbacks).toEqual({ "http-503": 11 });
    expect(results.examples.every((example) => example.scores[0] === null)).toBe(true);
  }, 60_000);

  it("judges a reminder on the release threshold even when the worker carries a threshold cap", async () => {
    answerInOrder(scripted());
    const cell = bench(
      new FakeCelldStorage(),
      {},
      {
        SECBOT_MARK_THRESHOLD_CAPS: '{"set_reminder":0}',
      },
    );
    await call(cell, "POST", "/lab/guard-bench?examples=1&repeat=1");
    const results = await examplesFinished(cell);
    // A cap of 0 would mark the routine reminder; the bench's guard never reads the cap.
    expect(results.examples.find((example) => example.name.includes("bins out"))).toMatchObject({
      threshold: 0.5,
      marked: [false],
      ok: true,
    });
    expect(results.allOk).toBe(true);
  }, 60_000);

  it("refuses a repeat outside 1-3 and a request for both runs", async () => {
    const cell = bench();
    for (const query of [
      "examples=1&repeat=0",
      "examples=1&repeat=4",
      "examples=1&repeat=x",
      "examples=2",
      "examples=1&calls=5",
    ]) {
      expect((await call(cell, "POST", `/lab/guard-bench?${query}`)).status).toBe(400);
    }
  });

  it("closes its harness once when celld closes its database mid-run, and the next run opens a new one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stub.delayMs = 100;
    const storage = new FakeCelldStorage();
    const cell = bench(storage, { deadlineMs: 2_000 });
    const events: string[] = [];
    const count = (name: string) => events.filter((event) => event === name).length;
    // Without the fix the harness retries without end; the guard ends the loop after 200 reports.
    const stop = onLogEvent((event) => {
      events.push(event);
      if (count("harness.report") === 200) storage.gaveBack = undefined;
    });
    try {
      await call(cell, "POST", "/lab/guard-bench?calls=20");
      await until(async () => count("guard.verdict") > WARMUP_CALLS);
      storage.gaveBack = "GuardBenchCell:bench-test";
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(count("cell.reopen")).toBe(1);
      expect(count("harness.report")).toBeLessThan(5);
      storage.gaveBack = undefined;
      expect((await finished(cell)).timedOut).toBe(true);
      stub.delayMs = 0;
      // The new harness also resumes the cut-off turn, so a call more than asked for can land.
      await call(cell, "POST", "/lab/guard-bench?calls=5");
      const again = await finished(cell);
      expect(again.timedOut).toBe(false);
      expect(again.measured).toBeGreaterThanOrEqual(5);
      expect(count("cell.reopen")).toBe(1);
    } finally {
      stop();
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
        tool: "household_read",
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

describe("the examples verdict", () => {
  const examples = benchExamples();
  const sampleFor = (index: number, score: number | null, fallback: string | null = null) =>
    sampleOf({
      tool: examples[index]?.tool,
      duration_ms: 500,
      verdict: "allowed",
      decision: fallback === null ? "pass" : "fallback",
      decision_score: score,
      decision_model: fallback === null ? "typesafe/jev-1.13-x" : null,
      fallback,
      cost_usd: 0.00002,
    });
  const right = (index: number) =>
    sampleFor(index, examples[index]?.expected === "mark" ? 0.9 : 0.05);
  const index = (tool: string, expected: string) =>
    examples.findIndex((example) => example.tool === tool && example.expected === expected);

  it("passes only when every repeat holds; a short run, a fallback, or a wrong tool is a miss", () => {
    const all = [...examples.keys(), ...examples.keys()].map(right);
    expect(summarizeExamples(examples, 2, all).allOk).toBe(true);
    // A risky example right on its threshold is marked.
    const risky = index("set_reminder", "mark");
    const edge = all.map((sample, i) => (i === risky ? sampleFor(risky, 0.5) : sample));
    expect(summarizeExamples(examples, 2, edge).allOk).toBe(true);
    // A routine example on its threshold is a mark, so a miss.
    const routine = index("set_reminder", "pass");
    const marked = all.map((sample, i) => (i === routine ? sampleFor(routine, 0.5) : sample));
    expect(summarizeExamples(examples, 2, marked).examples[routine]?.ok).toBe(false);
    // Only the second repeat misses: the example fails.
    const second = all.map((sample, i) => (i === examples.length ? sampleFor(0, 0.95) : sample));
    expect(summarizeExamples(examples, 2, second).allOk).toBe(false);
    expect(summarizeExamples(examples, 2, all.slice(0, -1)).allOk).toBe(false);
    expect(summarizeExamples(examples, 2, all, true).allOk).toBe(false);
    const fallback = all.map((sample, i) => (i === 3 ? sampleFor(3, null, "timeout") : sample));
    const failed = summarizeExamples(examples, 2, fallback);
    expect(failed.allOk).toBe(false);
    expect(failed.fallbacks).toEqual({ timeout: 1 });
    const [first, next, ...rest] = all;
    if (first === undefined || next === undefined) throw new Error("no samples");
    expect(summarizeExamples(examples, 2, [next, first, ...rest]).allOk).toBe(false);
    expect(summarizeExamples([], 2, []).allOk).toBe(false);
  });
});
