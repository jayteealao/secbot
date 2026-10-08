// `secbot rules` and `secbot activity` against the fake cell: the exact designed text, the
// refused edit on stderr with exit 1, usage errors with exit 2, and the owner's operator-key path
// (its header only with --owner/--person, the key never printed).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-cli-guard-"));
});
afterEach(async () => {
  await cell?.close();
  cell = undefined;
  await rm(dir, { recursive: true, force: true });
});

function testIo() {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: async function* () {},
  };
  return { io, out: () => out, err: () => err };
}

async function setup() {
  const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
  expect(await run(["device", "new", "laptop"], { environment, io: testIo().io })).toBe(0);
  const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
  cell = await startFakeCell(device.key);
  environment.env.SECBOT_CELL_URL = cell.url;
  return { environment, fake: cell, key: device.key };
}

async function secbot(
  environment: { env: Record<string, string>; home: string },
  ...argv: string[]
) {
  const { io, out, err } = testIo();
  const code = await run(argv, { environment, io });
  return { code, out: out(), err: err() };
}

const rule = (
  agent: string,
  tool: string,
  verdict: string,
  extra: Record<string, unknown> = {},
) => ({
  agent,
  tool,
  verdict,
  source: "default",
  addedAt: 0,
  ...extra,
});

const FIRST_RUN = [
  "OWNER RULES (you cannot loosen these)",
  "------------------------------------------------------------------------------",
  "AGENT   TOOL               MATCH                          VERDICT",
  "all     pay tools          any                            prohibit",
  "",
  "YOUR RULES",
  "------------------------------------------------------------------------------",
  "AGENT   TOOL               MATCH                          VERDICT",
  "all     handoff            any                            permit",
  "all     household_change   any                            permit",
  "all     set_reminder       any                            permit",
  "all     search_history     any                            permit",
  "",
].join("\n");

// The designed `secbot rules list` text, line for line.
const CONTRACT_LIST = [
  "OWNER RULES (you cannot loosen these)",
  "------------------------------------------------------------------------------",
  "AGENT   TOOL               MATCH                          VERDICT",
  "all     pay tools          any                            prohibit",
  "all     handoff            specialist = developer         ask first",
  "",
  "YOUR RULES",
  "------------------------------------------------------------------------------",
  "AGENT   TOOL               MATCH                          VERDICT",
  "lead    handoff            any                            ask first",
  "lead    handoff            specialist = research          permit",
  "          added by allow always, 8 Oct 14:02",
  "lead    set_reminder       text ~ /\\b(card|iban)\\b/i      ask first",
  "all     household_change   any                            permit",
  "all     set_reminder       any                            permit",
  "all     search_history     any                            permit",
  "",
].join("\n");

const DEFAULTS = {
  owner: [rule("all", "pay", "prohibit", { source: "release" })],
  person: [
    rule("all", "handoff", "permit"),
    rule("all", "household_change", "permit"),
    rule("all", "set_reminder", "permit"),
    rule("all", "search_history", "permit"),
  ],
  timeZone: "UTC",
};

const everyLineFits = (text: string) =>
  // At most 80 columns, and no escape character (no color or terminal control codes).
  text.split("\n").every((line) => line.length <= 80 && !line.includes(String.fromCharCode(27)));

describe("secbot rules", () => {
  it("lists the owner rules and the four defaults for a new person", async () => {
    const { environment, fake } = await setup();
    fake.rules = structuredClone(DEFAULTS);
    const result = await secbot(environment, "rules", "list");
    expect(result).toEqual({ code: 0, out: FIRST_RUN, err: "" });
  });

  it("prints the designed rules list, allow-always line and regular expression included", async () => {
    const { environment, fake } = await setup();
    fake.rules = {
      owner: [
        rule("all", "pay", "prohibit", { source: "release" }),
        rule("all", "handoff", "ask-first", {
          source: "owner",
          match: { kind: "exact", field: "specialist", value: "developer" },
        }),
      ],
      person: [
        rule("lead", "handoff", "ask-first", { source: "person" }),
        rule("lead", "handoff", "permit", {
          source: "allow-always",
          addedAt: Date.UTC(2026, 9, 8, 14, 2),
          match: { kind: "exact", field: "specialist", value: "research" },
        }),
        rule("lead", "set_reminder", "ask-first", {
          source: "person",
          match: { kind: "regex", field: "text", value: "\\b(card|iban)\\b" },
        }),
        rule("all", "household_change", "permit"),
        rule("all", "set_reminder", "permit"),
        rule("all", "search_history", "permit"),
      ],
      timeZone: "UTC",
    };
    const result = await secbot(environment, "rules", "list");
    expect(result.out).toBe(CONTRACT_LIST);
    expect(everyLineFits(result.out)).toBe(true);
  });

  it("adds and removes a rule with a match and prints one confirmation line each", async () => {
    const { environment, fake } = await setup();
    fake.rules = structuredClone(DEFAULTS);
    const added = await secbot(
      environment,
      "rules",
      "add",
      "lead",
      "handoff",
      "permit",
      "--exact",
      "specialist=research",
    );
    expect(added).toEqual({
      code: 0,
      out: "added: lead handoff (specialist = research) -> permit\n",
      err: "",
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/cells/owner/rules",
      body: {
        agent: "lead",
        tool: "handoff",
        verdict: "permit",
        match: { kind: "exact", field: "specialist", value: "research" },
      },
    });
    expect((await secbot(environment, "rules", "list")).out).toContain(
      "lead    handoff            specialist = research          permit",
    );
    const removed = await secbot(
      environment,
      "rules",
      "remove",
      "lead",
      "handoff",
      "--exact",
      "specialist=research",
    );
    expect(removed.out).toBe("removed: lead handoff (specialist = research) -> permit\n");
    expect((await secbot(environment, "rules", "list")).out).toBe(FIRST_RUN);
  });

  it("prints a refused edit on stderr exactly and exits 1", async () => {
    const { environment, fake } = await setup();
    fake.refuseNextAdd =
      "refused: this rule is looser than an owner rule:\n  all handoff (specialist = developer) -> ask first\n  Your rules can be stricter than the owner's rules, never looser.";
    const result = await secbot(
      environment,
      "rules",
      "add",
      "lead",
      "handoff",
      "permit",
      "--exact",
      "specialist=developer",
    );
    expect(result).toEqual({
      code: 1,
      out: "",
      err: [
        "secbot: refused: this rule is looser than an owner rule:",
        "  all handoff (specialist = developer) -> ask first",
        "  Your rules can be stricter than the owner's rules, never looser.",
        "",
      ].join("\n"),
    });
  });

  it.each([
    [["rules", "add", "lead", "handoff"], "usage: secbot rules add"],
    [["rules", "add", "lead", "handoff", "maybe"], "the verdict is one of"],
    [
      ["rules", "add", "lead", "handoff", "permit", "--exact", "a=b", "--prefix", "c=d"],
      "at most one match",
    ],
    [["rules", "add", "lead", "handoff", "permit", "--exact", "specialist"], "--exact takes"],
    [["rules", "remove", "lead"], "usage: secbot rules remove"],
    [["rules", "list", "--owner"], "--owner and --person"],
    [["activity", "--month", "2026-13"], "--month takes YYYY-MM"],
  ])("exits 2 on %j", async (argv, message) => {
    const { environment } = await setup();
    const result = await secbot(environment, ...argv);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(everyLineFits(result.err)).toBe(true);
  });

  it("wraps a long refusal on stderr within 80 columns", async () => {
    const { environment, fake } = await setup();
    fake.refuseNextAdd =
      "refused: this rule already exists: lead search_history (query = a long search about trains to Leeds) -> ask first";
    const result = await secbot(environment, "rules", "add", "lead", "search_history", "ask-first");
    expect(result).toEqual({
      code: 1,
      out: "",
      err: [
        "secbot: refused: this rule already exists: lead search_history (query = a long",
        "  search about trains to Leeds) -> ask first",
        "",
      ].join("\n"),
    });
  });
});

const RECORDS = [
  {
    at: Date.UTC(2026, 9, 8, 14, 2),
    agent: "lead",
    tool: "handoff",
    verdict: "allowed",
    layer: "rule",
    reason: "your rule: all handoff (any) -> permit",
    arguments: { specialist: "research", brief: "trains" },
    cost: 0,
  },
  {
    at: Date.UTC(2026, 9, 8, 9, 15),
    agent: "household",
    tool: "pay_test",
    verdict: "refused",
    layer: "rule",
    reason: "owner rule: any pay tool -> prohibit",
    arguments: { amount: 5 },
    cost: 0,
  },
];

describe("secbot activity", () => {
  it("lists the month's verdicts in the designed columns, newest first", async () => {
    const { environment, fake } = await setup();
    fake.activity = {
      person: "owner",
      month: "2026-10",
      timeZone: "UTC",
      total: 214,
      records: RECORDS,
      next: 212,
    };
    const result = await secbot(environment, "activity");
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        // The total ends at column 78, under the end of the dash rule.
        `${"ACTIVITY  owner  October 2026".padEnd(62)}[ total: $0.00 ]`,
        "------------------------------------------------------------------------------",
        "TIME   AGENT      TOOL OR JOB              VERDICT       LAYER       COST",
        "14:02  lead       handoff -> research      allowed       rule      $0.0000",
        "         your rule: all handoff (any) -> permit",
        "09:15  household  pay_test                 refused       rule      $0.0000",
        "         owner rule: any pay tool -> prohibit",
        "showing 2 of 214 this month; older: secbot activity --month 2026-09",
        "",
      ].join("\n"),
    );
    expect(everyLineFits(result.out)).toBe(true);
  });

  it("says when the month has no activity, and passes --month on", async () => {
    const { environment, fake } = await setup();
    expect((await secbot(environment, "activity")).out).toContain("\nno activity this month\n");
    fake.activity = { ...fake.activity, month: "2026-09" };
    const older = await secbot(environment, "activity", "--month", "2026-09");
    expect(older.out).toContain("no activity in September 2026");
    expect(fake.calls.at(-1)?.path).toBe("/v1/cells/owner/activity?month=2026-09");
  });
});

describe("the owner's operator-key views", () => {
  it("reads and edits owner rules and reads activity for a person, never printing the key", async () => {
    const { environment, fake, key } = await setup();
    environment.env.SECBOT_OPERATOR_KEY = fake.operatorKey;
    fake.rules = structuredClone(DEFAULTS);
    const list = await secbot(environment, "rules", "list", "--owner", "--person", "sam");
    expect(list.code).toBe(0);
    expect(list.out).toContain("SAM'S RULES");
    expect(fake.calls.at(-1)?.path).toBe("/ops/rules?cell=sam");
    expect(fake.calls.at(-1)?.auth).toBeUndefined();
    const added = await secbot(
      environment,
      "rules",
      "add",
      "all",
      "handoff",
      "ask-first",
      "--exact",
      "specialist=developer",
      "--owner",
      "--person",
      "sam",
    );
    expect(added.out).toBe("added: all handoff (specialist = developer) -> ask first\n");
    expect(fake.rules.owner).toHaveLength(2);
    fake.activity = { ...fake.activity, person: "sam", records: RECORDS, total: 2 };
    const activity = await secbot(environment, "activity", "--person", "sam");
    expect(activity.out.split("\n")[0]).toBe(
      `${"ACTIVITY  sam (operator key)  October 2026".padEnd(62)}[ total: $0.00 ]`,
    );
    expect(activity.out).toContain("older: secbot activity --person sam --month 2026-09");
    const everything = [list, added, activity].map((r) => r.out + r.err).join("");
    expect(everything).not.toContain(fake.operatorKey);
    expect(everything).not.toContain(key);
    // Without --person the header carries no operator mark.
    fake.activity = { ...fake.activity, person: "owner" };
    expect((await secbot(environment, "activity")).out).not.toContain("operator key");
  });

  it("refuses the owner views without an operator key", async () => {
    const { environment } = await setup();
    const result = await secbot(environment, "activity", "--person", "sam");
    expect(result.code).toBe(1);
    expect(result.err).toContain("no operator key");
  });
});
