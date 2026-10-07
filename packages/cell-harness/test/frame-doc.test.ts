// The cell API reference lists exactly the session frames the cell sends, so a new frame type
// cannot ship without its documentation.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FRAME_TYPES } from "../src/session-stream.ts";

const doc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "docs",
    "reference",
    "cell-api.md",
  ),
  "utf8",
);

/** The first column of the table that follows "The cell sends these". */
function documentedFrames(text: string): string[] {
  const start = text.indexOf("The cell sends these");
  expect(start).toBeGreaterThan(-1);
  const frames: string[] = [];
  let inTable = false;
  for (const line of text.slice(start).split(/\r?\n/)) {
    if (line.startsWith("|")) {
      inTable = true;
      const name = /^\| `([a-z]+)` \|/.exec(line)?.[1];
      if (name !== undefined) frames.push(name);
    } else if (inTable) {
      break;
    }
  }
  return frames;
}

describe("the cell API reference", () => {
  it("documents every frame type the cell sends, and no other", () => {
    expect([...documentedFrames(doc)].sort()).toEqual([...FRAME_TYPES].sort());
  });
});
