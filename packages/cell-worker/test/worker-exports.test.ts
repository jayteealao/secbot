// The test-cell worker module's named exports. The cell runtime loads every named export of the
// worker's main module as an entry point and refuses the whole deployment when one is not a
// class, a function, or a handler object (a string constant made the test cell keep serving the
// previous version). Helpers the module needs stay unexported.
import { describe, expect, it } from "vitest";
import * as conformanceEntry from "../src/conformance-entry.ts";

describe("the test-cell worker module", () => {
  it("exports only classes, functions, or handler objects", () => {
    const loadable = (value: unknown) =>
      typeof value === "function" || (typeof value === "object" && value !== null);
    const refused = Object.entries(conformanceEntry)
      .filter(([, value]) => !loadable(value))
      .map(([name]) => name);
    expect(refused).toEqual([]);
  });
});
