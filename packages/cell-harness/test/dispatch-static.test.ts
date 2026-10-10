// In the dispatch code (the CLI and the cell worker), no flag, keyword, pattern, or
// specialist name routes a message; routing exists only as the lead's handoff tool. The scan reads
// every source file of both packages; planted samples prove each rule can fail.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STARTER_SPECIALISTS } from "../src/release-defaults.ts";

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISPATCH_DIRS = [join(packages, "cli", "src"), join(packages, "cell-worker", "src")];
/**
 * Not dispatch code: the storage conformance run on the test cell compares assertion errors and
 * carries no messages; the test cell's durability lab holds a scripted model that stands in for
 * the lead's decision, like the tests' responders, and is never deployed to a person cell. The
 * held-call answer parser (the CLI's `held.ts`) sends an exact `/allow N`, `/always N`, or
 * `/deny N` line to the cell's approval route, never to any agent, and leaves every other line to
 * go to the lead unchanged; `held-chat.test.ts` proves both halves. The CLI's `budget-names.ts`
 * holds only the developer budget's name, which the cost and limits commands print and type; it
 * names a budget and routes nothing. The CLI's `secret-kinds.ts` holds only the broker kinds
 * (`health`, `production`) that `secbot secrets add --broker` types; a kind names the service the
 * secrets cell calls, and routes nothing.
 */
const NOT_DISPATCH = new Set([
  "budget-names.ts",
  "cell-assertions.ts",
  "conformance-cell.ts",
  "durability-lab.ts",
  "held.ts",
  "secret-kinds.ts",
]);

const names = STARTER_SPECIALISTS.map((specialist) => specialist.name).join("|");
const MESSAGE = "text|message|content|line|input|prompt|brief";

export const RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: "a specialist name in dispatch code",
    pattern: new RegExp(`["'\`](${names})["'\`]`),
  },
  {
    name: "a CLI option that chooses a target",
    pattern: /\b(to|specialist|route|agent|target|via|handoff)\s*:\s*\{\s*type\s*:/,
  },
  {
    name: "a keyword or pattern test on message text",
    pattern: new RegExp(
      `\\b(${MESSAGE})\\b(\\.\\w+)*\\.(includes|startsWith|endsWith|match|matchAll|search)\\(|\\.(test|exec)\\(\\s*(\\w+\\.)?(${MESSAGE})\\b`,
    ),
  },
  {
    name: "a direct submission to a specialist conversation",
    pattern: /specialists?\[[^\]]*\][^;]*\.submit\(|conversationId[^;]*submit\(/,
  },
];

export function violations(source: string): string[] {
  const found: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    for (const rule of RULES)
      if (rule.pattern.test(line)) found.push(`${index + 1}: ${rule.name}: ${line.trim()}`);
  }
  return found;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !NOT_DISPATCH.has(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("routing is only the lead's handoff tool", () => {
  it("finds no routing in the CLI or the cell worker", async () => {
    const files = (await Promise.all(DISPATCH_DIRS.map(sourceFiles))).flat();
    expect(files.length).toBeGreaterThan(8);
    const report: string[] = [];
    for (const file of files) {
      for (const hit of violations(await readFile(file, "utf8")))
        report.push(`${relative(packages, file)}:${hit}`);
    }
    expect(report).toEqual([]);
  });

  it.each([
    ['if (text.includes("recipe")) target = "household";', "keyword"],
    ["const ROUTE = /tax|invoice/; if (ROUTE.test(message)) send(1);", "pattern"],
    ['options: { to: { type: "string" } }', "flag"],
    ['await cell.submitTo("research", line);', "name"],
    ["await harness.conversation(roster.specialists[name].conversationId).submit(x);", "direct"],
    ["if (input.startsWith('/research')) forward();", "slash command"],
  ])("catches a planted %s", (sample) => {
    expect(violations(sample)).not.toEqual([]);
  });

  it("allows ordinary code", () => {
    expect(violations('const status = await client.request("GET", "/status");')).toEqual([]);
    expect(violations("const text = line.trim();")).toEqual([]);
  });
});
