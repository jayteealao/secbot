// The shared text helpers: no control or format character reaches the terminal, a long row stays
// inside 80 columns, and a right-aligned part that does not fit moves to its own line.
import { describe, expect, it } from "vitest";
import { columns, plain, rightAligned, wrap } from "../src/text.ts";

describe("text helpers", () => {
  it("shows escape sequences, bidirectional overrides, and zero-width characters as ?", () => {
    expect(plain("a\u001b[2Jb\u202Ec\u200Bd\u2028e")).toBe("a?[2Jb?c?d?e");
    const row = columns(["lead", "send\u001b[1Amail", "permit"], [0, 11, 30]);
    expect(row).toEqual(["lead       send?[1Amail       permit"]);
    expect(wrap("held \u001b[2K by the reviewer", 2)).toEqual(["  held ?[2K by the reviewer"]);
  });

  it("keeps a nine-letter agent on one row of the rules table", () => {
    expect(
      columns(["household", "handoff", "specialist = research", "permit"], [0, 11, 30, 61]),
    ).toEqual(["household  handoff            specialist = research          permit"]);
  });

  it("puts the right part on its own line when both parts do not fit", () => {
    expect(rightAligned("COST  ann  October 2026", "[ total: $1.00 ]")).toHaveLength(78);
    const long = rightAligned("x".repeat(70), "lapses in 1 h 0 m");
    expect(long.split("\n")).toEqual(["x".repeat(70), `${" ".repeat(61)}lapses in 1 h 0 m`]);
  });
});
