// The test cell's capacity bench on the stand-in: the real harness with its scripted lead, the
// jobs' model calls and the decision model on the stub OpenRouter (no outside call). A level of
// four jobs runs all four at once, the state reports each job's receipt and result, and a second
// level while one runs is refused; the routes refuse a level outside their bounds.
import { FakeCelldStorage, until } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import { benchBrief, CapacityBenchCell, type CapacityJob } from "../src/capacity-bench.ts";

const KEY = "capacity-test-key-0000"; // gitleaks:allow (fake test key)

let stub: StubOpenRouter;
const benches: CapacityBenchCell[] = [];
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
  const cell = new CapacityBenchCell(
    { storage: new FakeCelldStorage() },
    { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: stub.origin },
  );
  benches.push(cell);
  return cell;
};

const post = (cell: CapacityBenchCell, query: string) =>
  cell.fetch(new Request(`http://cell/lab/capacity?${query}`, { method: "POST" }));

const state = async (cell: CapacityBenchCell) =>
  (await (await cell.fetch(new Request("http://cell/lab/capacity-state"))).json()) as {
    level: number;
    done: boolean;
    startedAt: number | null;
    processStartedAt: number;
    jobs: CapacityJob[];
  };

describe("the capacity bench", () => {
  it("runs four jobs at once, reports their receipts and results, and refuses a second level", async () => {
    // Each model answer waits, so the four jobs are running together.
    stub.delayMs = 400;
    const cell = bench();
    const started = await post(cell, "jobs=4&slow=5");
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ started: true, level: 1, jobs: 4, slowSeconds: 5 });
    await until(
      async () => (await state(cell)).jobs.filter((job) => job.status === "running").length === 4,
    );
    expect((await post(cell, "jobs=2&slow=5")).status).toBe(409);
    await until(async () => (await state(cell)).done, 20_000);
    const done = await state(cell);
    expect(done.level).toBe(1);
    expect(done.processStartedAt).toBeGreaterThan(0);
    expect(done.jobs.map((job) => job.n)).toEqual([1, 2, 3, 4]);
    for (const job of done.jobs) {
      expect(job.status).toBe("done");
      expect(job.receiptMs).toBeGreaterThanOrEqual(0);
      expect(job.endedAt).not.toBeNull();
      expect((job.endedAt ?? 0) >= job.createdAt).toBe(true);
    }
    // The jobs' requests went to the stub; the scripted lead never did.
    const briefs = stub.seen.filter((seen) => JSON.stringify(seen.body).includes(benchBrief(1)));
    expect(briefs.length).toBeGreaterThan(0);
    expect(
      stub.seen.some((seen) => JSON.stringify(seen.body).includes("You are the lead agent")),
    ).toBe(false);
    // The next level reports only its own jobs.
    expect((await post(cell, "jobs=1&slow=5")).status).toBe(200);
    await until(async () => (await state(cell)).done, 20_000);
    expect((await state(cell)).jobs.map((job) => job.n)).toEqual([1]);
    expect((await state(cell)).level).toBe(2);
  }, 60_000);

  it("refuses a level outside its bounds", async () => {
    const cell = bench();
    for (const query of [
      "jobs=0&slow=5",
      "jobs=17&slow=5",
      "jobs=2&slow=4",
      "jobs=2&slow=301",
      "jobs=x&slow=5",
      "slow=5",
    ]) {
      expect((await post(cell, query)).status, query).toBe(400);
    }
    expect((await state(cell)).level).toBe(0);
  });
});
