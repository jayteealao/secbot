// The shared-job stand-in's own checks, before the end-to-end proofs lean on it: on one fleet and
// on two, each person reaches their own cell with their own device, and a lead turn costs money.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { until } from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SharedSetup, sharedSetup } from "./shared-setup.ts";

let s: SharedSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

describe.each([1, 2] as const)("the shared-job stand-in on %i fleet(s)", (fleets) => {
  it("serves secbot jobs to each person with their own device", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets });
    for (const person of ["owner", "second"]) {
      const ran = await s.secbotAs(person, ["jobs"]);
      expect(ran.err).toBe("");
      expect(ran.code).toBe(0);
      expect(ran.out).toContain(`JOBS  ${person}`);
    }
  });

  it("books a lead turn's cost on the month", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets });
    expect((await s.secbotAs("second", ["jobs"])).code).toBe(0);
    const harness = s.harness("second");
    await (await harness.submit("hello there", "smoke-1")).wait(BACKGROUND_CONTEXT);
    await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
    await until(async () => (await harness.cost()).spentUsd > 0);
    expect((await harness.cost()).spentUsd).toBeGreaterThan(0);
  });
});

describe("a used-up budget and a lost answer on the stand-in", () => {
  it("budgetOver makes the household read the person as used up", { timeout: 60_000 }, async () => {
    quiet();
    s = await sharedSetup({ fleets: 2 });
    for (const person of ["owner", "second"])
      expect((await s.secbotAs(person, ["jobs"])).code).toBe(0);
    const household = s.household;
    if (household === undefined) throw new Error("no household cell");
    const report = async (person: string) =>
      (await household.budget()).reports.find((each) => each.cell === person);
    await s.budgetOver("owner");
    const over = await report("owner");
    expect(over?.spentUsd).toBeGreaterThanOrEqual(over?.limitUsd ?? Number.POSITIVE_INFINITY);
    await s.budgetOver("second");
    const second = await report("second");
    expect(second?.spentUsd).toBeGreaterThanOrEqual(second?.limitUsd ?? Number.POSITIVE_INFINITY);
    await s.budgetBack("owner");
    const back = await report("owner");
    expect(back?.spentUsd).toBeLessThan(back?.limitUsd ?? 0);
  });

  it("dropNextAnswer loses one answer; the same ops go again and apply once", {
    timeout: 60_000,
  }, async () => {
    quiet();
    s = await sharedSetup({ fleets: 2 });
    for (const person of ["owner", "second"])
      expect((await s.secbotAs(person, ["jobs"])).code).toBe(0);
    const owner = s.harness("owner");
    s.dropNextAnswer("owner");
    await (await owner.submit("SHARE plan the May trip", "drop-1")).wait(BACKGROUND_CONTEXT);
    const setup = s;
    await until(() => setup.crossFleetSyncs.some((sync) => sync.status === 503));
    const lost = setup.crossFleetSyncs.find((sync) => sync.status === 503);
    expect(lost?.opIds.length).toBeGreaterThan(0);
    const outbox = async () =>
      Object.values((await owner.board()).jobs).flatMap((row) =>
        (row.shared?.outbox ?? []).map((op) => op.opId),
      );
    expect(await outbox()).toEqual(lost?.opIds);
    expect((await owner.syncShared()).outcome).toBe("ok");
    const again = setup.crossFleetSyncs.find(
      (sync) => sync.status === 200 && sync.opIds.join() === lost?.opIds.join(),
    );
    expect(again).toBeDefined();
    expect(await outbox()).toEqual([]);
    const household = (await setup.household?.jobs())?.rows ?? [];
    expect(household).toHaveLength(1);
  });
});
