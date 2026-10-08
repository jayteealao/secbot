import { describe, expect, it } from "vitest";
import { cellAssertions, looselyEqual, partiallyEqual } from "../src/cell-assertions.ts";

// Each pair is checked against Vitest's own toEqual / toMatchObject, so the in-cell assertions
// keep the semantics pi-durable's suite was written for.
const equalPairs: [unknown, unknown][] = [
  [{ a: 1, b: undefined }, { a: 1 }],
  [
    [1, { x: "y" }],
    [1, { x: "y" }],
  ],
  [new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  [{ a: [1, 2] }, { a: [1, 3] }],
  [{ a: 1 }, { a: 1, b: 2 }],
  [null, undefined],
  [[1], [1, 2]],
  [new Uint8Array([1]), new Uint8Array([2])],
  [1, { a: 1 }],
];

const matchPairs: [unknown, unknown][] = [
  [{ a: 1, b: 2 }, { a: 1 }],
  [{ a: { b: 1, c: 2 } }, { a: { b: 1 } }],
  [[{ a: 1, b: 2 }], [{ a: 1 }]],
  [{ a: 1 }, { a: 1, b: 2 }],
  [[{ a: 1 }], [{ a: 1 }, { a: 2 }]],
  [{ a: 1 }, { a: undefined }],
  ["x", { a: 1 }],
  [{ data: new Uint8Array([1]) }, { data: new Uint8Array([1]) }],
];

const vitestAgrees = (assertion: () => void): boolean => {
  try {
    assertion();
    return true;
  } catch {
    return false;
  }
};

describe("cell assertions", () => {
  it.each(equalPairs)("looselyEqual(%j, %j) agrees with toEqual", (actual, expected) => {
    expect(looselyEqual(actual, expected)).toBe(
      vitestAgrees(() => expect(actual).toEqual(expected)),
    );
  });

  it.each(matchPairs)("partiallyEqual(%j, %j) agrees with toMatchObject", (actual, expected) => {
    const vitest = vitestAgrees(() => expect(actual).toMatchObject(expected as object));
    expect(partiallyEqual(actual, expected)).toBe(vitest);
  });

  it("throws on each failed assertion", async () => {
    expect(() => cellAssertions.ok(0)).toThrow("truthy");
    expect(() => cellAssertions.ok(false, "custom")).toThrow("custom");
    expect(() => cellAssertions.strictEqual(1, 2)).toThrow("to be 2");
    expect(() => cellAssertions.deepEqual({ a: 1n }, { a: 2 })).toThrow("to equal");
    expect(() => cellAssertions.partialDeepEqual({ a: 1 }, { b: 1 })).toThrow("to match");
    expect(() => cellAssertions.greaterThan(1, 1)).toThrow("greater than");
    await expect(cellAssertions.rejects(Promise.resolve(1), "boom")).rejects.toThrow(
      "expected a rejection",
    );
    await expect(
      cellAssertions.rejects(Promise.reject(new Error("other")), "boom"),
    ).rejects.toThrow('got "other"');
    await expect(cellAssertions.rejects(Promise.reject("boom!"), "boom")).resolves.toBeUndefined();
  });

  it("passes on each held assertion", () => {
    cellAssertions.ok(1);
    cellAssertions.strictEqual("a", "a");
    cellAssertions.deepEqual({ a: [1] }, { a: [1] });
    cellAssertions.partialDeepEqual({ a: 1, b: 2 }, { a: 1 });
    cellAssertions.greaterThan(2, 1);
  });
});
