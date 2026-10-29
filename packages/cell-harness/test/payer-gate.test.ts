// The household's payer gate: a shared job waits while every person who pays for it is at or over
// their limit by their newest report, checks again on its timer, and an abort ends the wait.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOps, createPayerGate, type PayerReport } from "../src/shared-jobs.ts";
import { type HouseholdStandIn, openHouseholdStandIn, propose } from "./shared-helpers.ts";

let house: HouseholdStandIn | undefined;
afterEach(async () => {
  await house?.close();
  house = undefined;
  vi.restoreAllMocks();
});

const report = (cell: string, spentUsd: number): PayerReport => ({ cell, spentUsd, limitUsd: 25 });

async function setUp(joined: boolean) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  house = await openHouseholdStandIn();
  const h = house;
  await h.commit((tx) => applyOps(tx, "owner", [propose()], { task: h.task, now: 1 }));
  if (joined) {
    // Joined without a run: the gate reads only the shared store.
    await h.commit(async (tx) => {
      const { SharedJobsDoc } = await import("../src/shared-jobs.ts");
      const entry = (await tx.doc(SharedJobsDoc)).jobs["1"];
      if (entry !== undefined) entry.consent = "joined";
    });
  }
  let reports: PayerReport[] = [];
  const fires: (() => void)[] = [];
  const changes: number[] = [];
  const gate = createPayerGate({
    harness: () => h.harness,
    budgets: async () => reports,
    setTimer: (_ms, fire) => {
      fires.push(fire);
      return () => {};
    },
    onWaitChange: () => changes.push(gate.waiting().size),
  });
  return {
    gate,
    setReports: (next: PayerReport[]) => {
      reports = next;
    },
    tick: () => fires.shift()?.(),
    timers: () => fires.length,
    changes,
  };
}

const request = { budget: "person" as const, taskId: "9", what: "job 1 household" };
const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
};

describe("the payer gate", () => {
  it("does not wait when only one paying person is over", async () => {
    const t = await setUp(true);
    t.setReports([report("owner", 30), report("second", 1)]);
    await t.gate.waitUntilUnder(request, BACKGROUND_CONTEXT);
    expect(t.gate.waiting().size).toBe(0);
    expect(t.changes).toEqual([]);
  });

  it("waits while both are over, and the wait ends once one report drops under", async () => {
    const t = await setUp(true);
    t.setReports([report("owner", 30), report("second", 26)]);
    const wait = t.gate.waitUntilUnder(request, BACKGROUND_CONTEXT);
    expect(await settled(wait)).toBe(false);
    expect([...t.gate.waiting()]).toEqual([1]);
    t.tick();
    expect(await settled(wait)).toBe(false);
    t.setReports([report("owner", 30), report("second", 10)]);
    t.tick();
    await wait;
    expect(t.gate.waiting().size).toBe(0);
    expect(t.changes).toEqual([1, 0]);
  });

  it("waits on the requesting person alone before the other person joined", async () => {
    const t = await setUp(false);
    t.setReports([report("owner", 30)]);
    const wait = t.gate.waitUntilUnder(request, BACKGROUND_CONTEXT);
    expect(await settled(wait)).toBe(false);
    t.setReports([report("owner", 3)]);
    t.tick();
    await wait;
  });

  it("ends the wait on an abort", async () => {
    const t = await setUp(true);
    t.setReports([report("owner", 30), report("second", 26)]);
    const abort = new AbortController();
    const context = { ...BACKGROUND_CONTEXT, abortSignal: abort.signal } as Context;
    const wait = t.gate.waitUntilUnder(request, context);
    expect(await settled(wait)).toBe(false);
    abort.abort(new Error("stopped"));
    await expect(wait).rejects.toThrow("stopped");
    expect(t.gate.waiting().size).toBe(0);
  });

  it("lets a request that names no job through", async () => {
    const t = await setUp(true);
    t.setReports([report("owner", 30), report("second", 26)]);
    await t.gate.waitUntilUnder({ ...request, what: "routine heartbeat" }, BACKGROUND_CONTEXT);
    expect(t.timers()).toBe(0);
  });
});
