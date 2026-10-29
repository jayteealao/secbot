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
