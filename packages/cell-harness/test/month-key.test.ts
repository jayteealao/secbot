// Activity pages and the spend ledger name the same month for one moment, also when the cell's
// own zone and the household zone (the ledger's) differ around a month's end.
import { describe, expect, it } from "vitest";
import { monthKey } from "../src/activity.ts";

describe("monthKey", () => {
  // The ledger runs on Tokyo time: November starts at 15:00 UTC on 31 October.
  const november = {
    month: "2026-11",
    zone: "Asia/Tokyo",
    startsAt: Date.UTC(2026, 9, 31, 15),
    endsAt: Date.UTC(2026, 10, 30, 15),
  };

  it("uses the ledger's month while the moment is in it, whatever the cell's zone says", () => {
    const at = Date.UTC(2026, 9, 31, 20); // still October in London
    expect(monthKey(at, "Europe/London", november)).toBe("2026-11");
  });

  it("uses the ledger's zone for a moment outside its month", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 14), "Europe/London", november)).toBe("2026-10");
    expect(monthKey(Date.UTC(2026, 10, 30, 16), "Europe/London", november)).toBe("2026-12");
  });

  it("uses the cell's zone before the ledger has a month", () => {
    const empty = { month: "", zone: "", startsAt: 0, endsAt: 0 };
    expect(monthKey(Date.UTC(2026, 9, 31, 20), "Europe/London", empty)).toBe("2026-10");
    expect(monthKey(Date.UTC(2026, 9, 31, 20), "Europe/London", undefined)).toBe("2026-10");
  });
});
