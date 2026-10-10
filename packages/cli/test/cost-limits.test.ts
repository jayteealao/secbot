// The month's spend in the command line against the fake cell: the usage line at 46%, 82%, and
// 101%, the limit notices in chat and in `secbot missed`, `secbot cost` for a person, for another
// person and for the household (operator key), and `secbot limits`. Every text is the visual
// contract's, line by line; usage errors exit 2, a missing operator key exits 1, the key is never
// printed, no line passes 80 columns, and no escape character is written.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costLines, householdLines } from "../src/commands/cost.ts";
import { amountOf } from "../src/commands/limits.ts";
import { type Notice, noticeBlock, usageLine, type Waiting } from "../src/commands/usage.ts";
import { CliError } from "../src/config.ts";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-cost-"));
});
afterEach(async () => {
  await cell?.close();
  cell = undefined;
  await rm(dir, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function testIo(lines: (out: () => string) => AsyncIterable<string> = async function* () {}) {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: () => lines(() => out),
  };
  return { io, out: () => out, err: () => err };
}

async function setup(withOperatorKey = true) {
  const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
  expect(await run(["device", "new", "laptop"], { environment, io: testIo().io })).toBe(0);
  const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
  cell = await startFakeCell(device.key);
  environment.env.SECBOT_CELL_URL = cell.url;
  if (withOperatorKey) environment.env.SECBOT_OPERATOR_KEY = cell.operatorKey;
  return { environment, fake: cell };
}

async function secbot(
  environment: { env: Record<string, string>; home: string },
  ...argv: string[]
) {
  const { io, out, err } = testIo();
  const code = await run(argv, { environment, io });
  return { code, out: out(), err: err() };
}

/** Every line at most 80 columns and no escape character (no color, no control codes). */
const plainText = (text: string) =>
  text.split("\n").every((line) => line.length <= 80) && !text.includes("\u001b");

const usage = (spentUsd: number, percent: number, line: "normal" | "warn" | "over") => ({
  spentUsd,
  limitUsd: 25,
  percent,
  line,
  mode: "shadow",
});

/** The usage lines of the visual contract. */
const USAGE_46 = "[ month: $11.52 / $25.00 ] [#####.....] 46% [ shadow ]";
const USAGE_82 = "[ month: $20.40 / $25.00 ] [########..] 82% [ 80% of limit ] [ shadow ]";
const USAGE_101 = "[ month: $25.30 / $25.00 ] [##########] 101% [ limit reached ] [ shadow ]";

const NOV_1 = Date.UTC(2026, 10, 1);
const notice = (seq: number, line: number, spentUsd: number, budget = "person"): Notice => ({
  seq,
  zone: "UTC",
  budget,
  line,
  spentUsd,
  limitUsd: budget === "developer" ? 50 : 25,
  resetsAt: NOV_1,
});
const at = (hour: number, minute: number) => Date.UTC(2026, 9, 20, hour, minute);
const WAITING: Waiting[] = [
  { what: "routine morning check", since: at(6, 0), budget: "person" },
  { what: "reminder bins out", since: at(19, 0), budget: "person" },
  { what: "handoff research train times", since: at(13, 58), budget: "person" },
];

/** The two limit notices of the visual contract. */
const NOTICE_80 = [
  "[ 80% of limit ] You have used $20.40 of $25.00 this month. At $25.00,",
  "  hand-offs, routines, and reminders wait. Chat with the lead continues.",
  "  Your limit resets on 1 Nov.",
];
const NOTICE_100 = [
  "[ limit reached ] You have used $25.30 of $25.00 this month. Hand-offs,",
  "  routines, and reminders wait until the owner raises your limit or the",
  "  month resets on 1 Nov. Nothing is dropped. Chat with the lead continues.",
  "  3 waiting: routine morning check (06:00), reminder bins out (19:00),",
  "  handoff research train times (13:58)",
];

/** The person view of `secbot cost` in the visual contract. */
const COST_VIEW = {
  person: "sam",
  month: "2026-10",
  timeZone: "UTC",
  resetsAt: NOV_1,
  mode: "shadow",
  modeSince: Date.UTC(2026, 9, 1),
  spentUsd: 11.52,
  limitUsd: 25,
  percent: 46,
  line: "normal",
  byLayer: { agent: 10.84, decision: 0.41, reviewer: 0.27 },
  byRole: { lead: 7.9, research: 2.31, household: 1.31 },
  hours: {},
  waiting: [],
  developer: { spentUsd: 3.1, limitUsd: 50, percent: 6, line: "normal" },
};
/**
 * The contract's lines; every header's right part ends at column 78, the rule's right edge, as
 * the activity and held-call headers do (the contract's mock spaces it by eye).
 */
const header = (left: string, right: string) => `${left}  `.padEnd(78 - right.length) + right;
const COST_LINES = [
  header("COST  sam  October 2026", "[ shadow ]  resets 1 Nov 00:00"),
  "------------------------------------------------------------------------------",
  "[ month: $11.52 / $25.00 ] [#########...........] 46%",
  "",
  "BY LAYER                     BY ROLE",
  "agent model       $10.84     lead          $7.90",
  "reviewer           $0.27     research      $2.31",
  "decision model     $0.41     household     $1.31",
];

const HOUSEHOLD = {
  month: "2026-10",
  timeZone: "UTC",
  totalUsd: 52.82,
  persons: [
    {
      person: "alex",
      spentUsd: 38.2,
      limitUsd: 60,
      percent: 64,
      line: "normal",
      mode: "shadow",
      modeSince: Date.UTC(2026, 9, 1),
      asOf: 0,
    },
    {
      person: "sam",
      spentUsd: 11.52,
      limitUsd: 25,
      percent: 46,
      line: "normal",
      mode: "shadow",
      modeSince: Date.UTC(2026, 9, 8),
      asOf: 0,
    },
  ],
  developer: { spentUsd: 3.1, limitUsd: 50, percent: 6, line: "normal" },
};
const HOUSEHOLD_NOW = Date.UTC(2026, 9, 15, 12);
const HOUSEHOLD_LINES = [
  header("COST  household  October 2026", "[ total: $52.82 ]"),
  "------------------------------------------------------------------------------",
  "PERSON            SPENT      LIMIT    USED   MODE",
  "alex             $38.20     $60.00     64%   shadow (14 d of logs)",
  "sam              $11.52     $25.00     46%   shadow (7 d of logs)",
  "developer         $3.10     $50.00      6%   budget",
  "switch to enforce from 15 Oct: secbot mode set <person> enforce",
];

describe("the usage line and limit notices", () => {
  it("renders the three usage lines of the contract", () => {
    expect(usageLine(usage(11.52, 46, "normal"))).toBe(USAGE_46);
    expect(usageLine(usage(20.4, 82, "warn"))).toBe(USAGE_82);
    expect(usageLine(usage(25.3, 101, "over"))).toBe(USAGE_101);
  });

  it("renders the two notices of the contract, and the developer budget's", () => {
    expect(noticeBlock(notice(1, 80, 20.4), WAITING)).toEqual(NOTICE_80);
    expect(noticeBlock(notice(2, 100, 25.3), WAITING)).toEqual(NOTICE_100);
    expect(noticeBlock(notice(3, 80, 40, "developer"), WAITING)).toEqual([
      "[ 80% of developer budget ] Developer jobs have used $40.00 of $50.00 this",
      "  month. At $50.00, developer jobs wait. Other work continues. The budget",
      "  resets on 1 Nov.",
    ]);
    const developer = noticeBlock(notice(4, 100, 50.3, "developer"), [
      { what: "job developer", since: at(9, 5), budget: "developer" },
      ...WAITING,
    ]);
    expect(developer).toEqual([
      "[ developer budget reached ] Developer jobs have used $50.30 of $50.00 this",
      "  month. They wait until the owner raises the budget or the month resets on",
      "  1 Nov. Nothing is dropped. Other work continues.",
      "  1 waiting: job developer (09:05)",
    ]);
  });

  it("prints the usage line on connect and after each answer, and a notice with a blank line before", async () => {
    const { environment, fake } = await setup();
    fake.connectFrames = [{ type: "usage", usage: usage(11.52, 46, "normal") }];
    let turn = 0;
    fake.onInput = (_input, socket) => {
      turn++;
      socket.send({ type: "delta", text: `answer ${turn}` });
      socket.send({ type: "answer", entryId: turn, text: `answer ${turn}` });
      if (turn === 1) {
        socket.send({ type: "usage", usage: usage(20.4, 82, "warn") });
        socket.send({ type: "notice", notice: notice(1, 80, 20.4), waiting: [] });
      } else {
        socket.send({ type: "usage", usage: usage(25.3, 101, "over") });
        socket.send({ type: "notice", notice: notice(2, 100, 25.3), waiting: WAITING });
        // A repeat of a notice this session has shown prints nothing.
        socket.send({ type: "notice", notice: notice(2, 100, 25.3), waiting: WAITING });
      }
    };
    const { io, out } = testIo(async function* (output) {
      yield "hello";
      await waitFor(() => output().includes("Your limit resets on 1 Nov."));
      yield "and again";
      await waitFor(() => output().includes("train times (13:58)"));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    expect(out()).toBe(
      [
        "connected to owner lead",
        USAGE_46,
        "answer 1",
        USAGE_82,
        "",
        ...NOTICE_80,
        "answer 2",
        USAGE_101,
        "",
        ...NOTICE_100,
        "",
      ].join("\n"),
    );
    expect(plainText(out())).toBe(true);
  });

  it("lists held calls, then notices, then missed messages in secbot missed", async () => {
    const { environment, fake } = await setup();
    fake.notices = [notice(1, 80, 20.4), notice(2, 100, 25.3)];
    fake.waiting = WAITING;
    fake.missed = [{ kind: "answer", entryId: 3, text: "the trains are booked" }];
    const first = await secbot(environment, "missed");
    expect(first).toEqual({
      code: 0,
      out: [...NOTICE_80, "", ...NOTICE_100, "", "lead: the trains are booked", ""].join("\n"),
      err: "",
    });
    expect(plainText(first.out)).toBe(true);
    // Shown once: the cell moved this device past them.
    expect(await secbot(environment, "missed")).toEqual({
      code: 0,
      out: "no missed messages\n",
      err: "",
    });
  });
});

describe("secbot cost", () => {
  it("shows the person's month with the contract's layout", async () => {
    expect(costLines(COST_VIEW, false)).toEqual(COST_LINES);
    const { environment, fake } = await setup();
    fake.cost = COST_VIEW;
    const result = await secbot(environment, "cost");
    expect(result).toEqual({
      code: 0,
      out: `${[header("COST  owner  October 2026", "[ shadow ]  resets 1 Nov 00:00"), ...COST_LINES.slice(1)].join("\n")}\n`,
      err: "",
    });
    expect(fake.calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/cells/owner/cost" });
  });

  it("shows another person's month and the household with the operator key", async () => {
    const { environment, fake } = await setup();
    fake.cost = COST_VIEW;
    fake.household = HOUSEHOLD;
    const person = await secbot(environment, "cost", "--person", "sam");
    expect(person.code).toBe(0);
    expect(person.out.split("\n")[0]).toBe(
      header("COST  sam (operator key)  October 2026", "[ shadow ]  resets 1 Nov 00:00"),
    );
    expect(householdLines(HOUSEHOLD, HOUSEHOLD_NOW)).toEqual(HOUSEHOLD_LINES);
    const household = await secbot(environment, "cost", "--owner");
    expect(household.code).toBe(0);
    // The mode column counts days from the real clock here; the rest is the contract's.
    const shown = household.out.split("\n");
    expect(shown.slice(0, 3)).toEqual(HOUSEHOLD_LINES.slice(0, 3));
    expect(shown[5]).toBe(HOUSEHOLD_LINES[5]);
    for (const text of [person.out, household.out]) {
      expect(plainText(text)).toBe(true);
      expect(text).not.toContain(fake.operatorKey);
    }
  });

  it("refuses --person with --owner (exit 2) and needs the operator key (exit 1)", async () => {
    const { environment } = await setup(false);
    const both = await secbot(environment, "cost", "--owner", "--person", "sam");
    expect(both.code).toBe(2);
    const keyless = await secbot(environment, "cost", "--owner");
    expect(keyless.code).toBe(1);
    expect(keyless.err).toContain("operator key");
  });
});

describe("secbot limits", () => {
  it("sets a person's limit, the developer budget, and the time zone with the contract's words", async () => {
    const { environment, fake } = await setup();
    expect(await secbot(environment, "limits", "set", "sam", "40")).toEqual({
      code: 0,
      out: "sam's monthly limit is now $40.00 from the next call\n",
      err: "",
    });
    expect(await secbot(environment, "limits", "developer", "60")).toEqual({
      code: 0,
      out: "the developer budget is now $60.00 from the next call\n",
      err: "",
    });
    expect(await secbot(environment, "limits", "zone", "Europe/London")).toEqual({
      code: 0,
      out: "the household time zone is now Europe/London from the next month\n",
      err: "",
    });
    expect(fake.limitChanges).toEqual([
      { path: "/ops/limits?cell=sam", body: { limitUsd: 40 } },
      { path: "/ops/limits?budget=developer", body: { limitUsd: 60 } },
      { path: "/ops/time-zone", body: { timeZone: "Europe/London" } },
    ]);
    // Only the operator-key header carried the key.
    for (const call of fake.calls.filter((each) => each.path.startsWith("/ops/"))) {
      expect(call.auth).toBeUndefined();
    }
  });

  it("shows each limit, the developer budget, and the time zone", async () => {
    const { environment, fake } = await setup();
    fake.household = HOUSEHOLD;
    expect(await secbot(environment, "limits", "show")).toEqual({
      code: 0,
      out: [
        "alex                 $60.00  a month",
        "sam                  $25.00  a month",
        "developer            $50.00  a month",
        "time zone UTC",
        "",
      ].join("\n"),
      err: "",
    });
  });

  it("refuses a bad amount or command (exit 2), a bad zone (exit 1), and a missing key (exit 1)", async () => {
    const { environment, fake } = await setup();
    for (const argv of [
      ["limits", "set", "sam", "0"],
      ["limits", "set", "sam", "12.345"],
      ["limits", "set", "sam", "lots"],
      ["limits", "developer"],
      ["limits"],
    ]) {
      expect((await secbot(environment, ...argv)).code).toBe(2);
    }
    const zone = await secbot(environment, "limits", "zone", "Mars/Olympus");
    expect(zone.code).toBe(1);
    expect(zone.err).toContain("not an IANA zone");
    expect(fake.limitChanges).toEqual([]);
    delete environment.env.SECBOT_OPERATOR_KEY;
    const keyless = await secbot(environment, "limits", "set", "sam", "40");
    expect(keyless.code).toBe(1);
    expect(keyless.err).toContain("operator key");
  });

  it("reads amounts as dollars with at most two decimals", () => {
    expect(amountOf("40")).toBe(40);
    expect(amountOf("$40.50")).toBe(40.5);
    expect(() => amountOf("-1")).toThrow(CliError);
  });
});
