// Who pays a shared job's cost: half each; the other person all when one budget is used up; half
// each again when both are (spend never drops).
import { describe, expect, it } from "vitest";
import { payerOf, splitCharge } from "../src/shared-split.ts";

const over =
  (...people: string[]) =>
  (person: string) =>
    people.includes(person);

describe("the split of a shared job's cost", () => {
  it("halves a charge when both people have budget left", () => {
    expect(splitCharge(0.4, "owner", "second", over())).toEqual({
      shares: { owner: 0.2, second: 0.2 },
      split: "half",
    });
  });

  it("gives the odd micro-dollar to the requesting person", () => {
    expect(splitCharge(0.000003, "owner", "second", over())).toEqual({
      shares: { owner: 0.000002, second: 0.000001 },
      split: "half",
    });
  });

  it("charges the other person all when one budget is used up", () => {
    expect(splitCharge(0.4, "owner", "second", over("second"))).toEqual({
      shares: { owner: 0.4, second: 0 },
      split: "all",
    });
    expect(splitCharge(0.4, "owner", "second", over("owner"))).toEqual({
      shares: { owner: 0, second: 0.4 },
      split: "all",
    });
  });

  it("halves a charge when both are over, so no spend is dropped", () => {
    expect(splitCharge(0.4, "owner", "second", over("owner", "second"))).toEqual({
      shares: { owner: 0.2, second: 0.2 },
      split: "half",
    });
  });

  it("charges nothing for zero", () => {
    expect(splitCharge(0, "owner", "second", over())).toEqual({
      shares: { owner: 0, second: 0 },
      split: "half",
    });
  });

  it("names who pays from each side", () => {
    expect(payerOf("requester", false, false)).toBe("half");
    expect(payerOf("other", false, false)).toBe("half");
    expect(payerOf("requester", false, true)).toBe("you");
    expect(payerOf("other", false, true)).toBe("them");
    expect(payerOf("requester", true, false)).toBe("them");
    expect(payerOf("other", true, false)).toBe("you");
    expect(payerOf("requester", true, true)).toBe("half");
  });
});
