// The held-out injection corpus: its counts and groups, unique names, long texts whose order
// comes after the first chunk, no text shared with the tool-call examples or the fixture pages,
// and the miss and false-positive rates it is scored by.
import { describe, expect, it } from "vitest";
import { chunkContent, READ_SIZES } from "../src/content-check.ts";
import { DECISION_EXAMPLES, HELD_OUT_EXAMPLES } from "../src/decision-examples.ts";
import {
  type CorpusResult,
  falsePositiveRate,
  INJECTION_CORPUS,
  missRate,
} from "../src/injection-corpus.ts";
import { CONTENT_CHUNK_BYTES } from "../src/release-defaults.ts";
import { FIXTURE_ORDER, FIXTURE_PAGES } from "./injection-fixtures.ts";

const utf8 = (text: string) => new TextEncoder().encode(text).length;
const count = (group: string) => INJECTION_CORPUS.filter((each) => each.group === group).length;

describe("the held-out injection corpus", () => {
  it("holds 40 injected texts in four groups of ten, and 40 clean texts", () => {
    expect(INJECTION_CORPUS).toHaveLength(80);
    for (const group of ["direct", "argues-for-label", "hidden", "long-tail"]) {
      expect(count(group)).toBe(10);
    }
    expect(count("clean")).toBe(40);
    for (const each of INJECTION_CORPUS) {
      expect(each.label).toBe(each.group === "clean" ? "clean" : "injection");
      expect(["page", "mail", "file"]).toContain(each.kind);
    }
    expect(new Set(INJECTION_CORPUS.map((each) => each.kind)).size).toBe(3);
  });

  it("names every case once", () => {
    expect(new Set(INJECTION_CORPUS.map((each) => each.name)).size).toBe(80);
  });

  it("makes every long text longer than a chunk, with its order after the first chunk", () => {
    for (const each of INJECTION_CORPUS.filter((one) => one.group === "long-tail")) {
      expect(utf8(each.text)).toBeGreaterThan(CONTENT_CHUNK_BYTES);
      const { chunks } = chunkContent(each.text, READ_SIZES);
      const order = each.text.split("\n")[1] ?? "";
      expect(order.length).toBeGreaterThan(40);
      expect(chunks[0]).not.toContain(order);
      expect(chunks.slice(1).some((chunk) => chunk.includes(order))).toBe(true);
    }
  });

  it("shares no text with the tool-call examples or the fixture pages", () => {
    const others = [
      ...[...DECISION_EXAMPLES, ...HELD_OUT_EXAMPLES].flatMap((example) =>
        Object.values(example.arguments).filter(
          (value): value is string => typeof value === "string",
        ),
      ),
      ...Object.values(FIXTURE_PAGES),
      FIXTURE_ORDER,
    ].filter((text) => text.length >= 12);
    for (const each of INJECTION_CORPUS) {
      for (const other of others) {
        expect(each.text.includes(other)).toBe(false);
        expect(other.includes(each.text)).toBe(false);
      }
    }
  });
});

describe("the corpus rates", () => {
  const results: CorpusResult[] = [
    { name: "a", group: "direct", label: "injection", outcome: "stopped" },
    { name: "b", group: "direct", label: "injection", outcome: "clean" },
    { name: "c", group: "hidden", label: "injection", outcome: "stopped" },
    { name: "d", group: "hidden", label: "injection", outcome: "stopped" },
    { name: "e", group: "clean", label: "clean", outcome: "clean" },
    { name: "f", group: "clean", label: "clean", outcome: "clean" },
    { name: "g", group: "clean", label: "clean", outcome: "clean" },
    { name: "h", group: "clean", label: "clean", outcome: "stopped" },
  ];

  it("counts an injected text passed as clean as a miss, overall and per group", () => {
    expect(missRate(results)).toEqual({ overall: 0.25, groups: { direct: 0.5, hidden: 0 } });
  });

  it("counts a clean text stopped as a false positive", () => {
    expect(falsePositiveRate(results)).toEqual({ overall: 0.25, groups: { clean: 0.25 } });
  });

  it("is zero with nothing to score", () => {
    expect(missRate([])).toEqual({ overall: 0, groups: {} });
  });
});
