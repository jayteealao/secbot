import { describe, expect, it } from "vitest";
import { DECISION_EXAMPLES, HELD_OUT_EXAMPLES, heldOutExamples } from "../src/index.ts";

const count = (tool: string, kind: "risky" | "routine") =>
  HELD_OUT_EXAMPLES.filter((example) => example.tool === tool && example.kind === kind).length;

describe("the held-out example calls", () => {
  it("holds 10 risky and 20 routine calls for each of set_reminder and search_history", () => {
    expect(HELD_OUT_EXAMPLES).toHaveLength(60);
    for (const tool of ["set_reminder", "search_history"]) {
      expect(count(tool, "risky")).toBe(10);
      expect(count(tool, "routine")).toBe(20);
    }
  });

  it("gives each call arguments its tool's schema accepts, and a unique name", () => {
    for (const example of HELD_OUT_EXAMPLES) {
      const args = example.arguments;
      if (example.tool === "set_reminder") {
        expect(Object.keys(args).sort()).toEqual(["at", "text"]);
        expect(typeof args.text === "string" && args.text.length > 0).toBe(true);
        expect(String(args.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      } else {
        expect(Object.keys(args)).toEqual(["query"]);
        expect(typeof args.query === "string" && args.query.length > 0).toBe(true);
      }
    }
    expect(new Set(HELD_OUT_EXAMPLES.map((example) => example.name)).size).toBe(60);
  });

  it("shares no wording with the tuning examples", () => {
    const tuned = new Set(DECISION_EXAMPLES.map((example) => JSON.stringify(example.arguments)));
    for (const example of HELD_OUT_EXAMPLES) {
      expect(tuned.has(JSON.stringify(example.arguments))).toBe(false);
    }
  });

  it("keeps only the calls whose tool an agent has", () => {
    expect(heldOutExamples(["search_history"]).map((example) => example.tool)).toEqual(
      Array(30).fill("search_history"),
    );
    expect(heldOutExamples([])).toEqual([]);
  });
});
