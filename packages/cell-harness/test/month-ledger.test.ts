// The month ledger: month bounds at local midnight on the first, also across a daylight-saving
// change; the guard's usage added under its two keys of `pi.usage`; spend read as the total less
// the month's baseline, never below zero.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addGuardUsage,
  costOnlyUsage,
  localMonthStart,
  monthBounds,
  readMonth,
  spendSince,
  zoneOffsetMs,
} from "../src/month-ledger.ts";
import { GUARD_USAGE_KEYS } from "../src/release-defaults.ts";
import { openTestCell, type TestCell } from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("month bounds", () => {
  it("runs from local midnight on the first to the next first", () => {
    expect(monthBounds(Date.UTC(2026, 9, 15), "UTC")).toEqual({
      month: "2026-10",
      startsAt: Date.UTC(2026, 9, 1),
      endsAt: Date.UTC(2026, 10, 1),
    });
    // London is on summer time on 1 October and on GMT on 1 November.
    expect(monthBounds(Date.UTC(2026, 9, 15), "Europe/London")).toEqual({
      month: "2026-10",
      startsAt: Date.UTC(2026, 8, 30, 23),
      endsAt: Date.UTC(2026, 10, 1),
    });
    // New York leaves daylight saving at 02:00 on 1 November 2026: the month starts before it.
    expect(monthBounds(Date.UTC(2026, 10, 15), "America/New_York")).toEqual({
      month: "2026-11",
      startsAt: Date.UTC(2026, 10, 1, 4),
      endsAt: Date.UTC(2026, 11, 1, 5),
    });
    expect(localMonthStart(2027, 4, "America/New_York")).toBe(Date.UTC(2027, 3, 1, 4));
    expect(localMonthStart(2027, 3, "America/New_York")).toBe(Date.UTC(2027, 2, 1, 5));
  });

  it("reads a month in the zone, not in UTC", () => {
    // 23:30 UTC on 31 October is already November in Tokyo.
    expect(monthBounds(Date.UTC(2026, 9, 31, 23, 30), "Asia/Tokyo").month).toBe("2026-11");
    expect(zoneOffsetMs(Date.UTC(2026, 6, 1), "Europe/London")).toBe(3_600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 1), "Asia/Kolkata")).toBe(19_800_000);
  });
});

describe("the ledger", () => {
  it("adds the guard's usage under its two keys of the calling conversation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await test.cell.harness.commit(async (tx) => {
      await addGuardUsage(tx, ROOT_CONVERSATION_ID, "decision", costOnlyUsage(0.01));
      await addGuardUsage(tx, ROOT_CONVERSATION_ID, "decision", costOnlyUsage(0.02));
      await addGuardUsage(tx, ROOT_CONVERSATION_ID, "reviewer", costOnlyUsage(0.5));
    }, BACKGROUND_CONTEXT);
    const usage = await test.cell.harness.snapshot(
      UsageDoc,
      ROOT_CONVERSATION_ID,
      BACKGROUND_CONTEXT,
    );
    expect(usage?.tools[GUARD_USAGE_KEYS.decision]?.cost.total).toBeCloseTo(0.03, 10);
    expect(usage?.tools[GUARD_USAGE_KEYS.reviewer]?.cost.total).toBeCloseTo(0.5, 10);
    const month = await readMonth(test.cell.harness, Date.now(), "UTC", BACKGROUND_CONTEXT);
    expect(month.person.byLayer.decision).toBeCloseTo(0.03, 10);
    expect(month.person.byLayer.reviewer).toBeCloseTo(0.5, 10);
    expect(month.person.byRole.lead).toBeCloseTo(0.53, 10);
  });

  it("counts the total less the baseline, never below zero", () => {
    expect(spendSince({ "m:a": 5, "t:b": 2 }, { "m:a": 3 })).toEqual({
      agent: 4,
      decision: 0,
      reviewer: 0,
    });
    expect(spendSince({ "m:a": 1, "t:secbot-guard:reviewer": 0.5 }, { "m:a": 3 })).toEqual({
      agent: 0,
      decision: 0,
      reviewer: 0.5,
    });
    expect(spendSince({ "m:a": 1 }, undefined)).toEqual({ agent: 1, decision: 0, reviewer: 0 });
  });
});
