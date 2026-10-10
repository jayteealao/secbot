// Held calls in the command line against the fake cell: the held-call block of the visual
// contract, the answers as exact slash commands only (a plain line goes to the lead, a malformed
// answer is not sent), every confirmation, and HELD CALLS first in `secbot missed`.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerOf, type HeldCall, heldBlock } from "../src/commands/held.ts";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-held-"));
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

async function setup() {
  const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
  expect(await run(["device", "new", "laptop"], { environment, io: testIo().io })).toBe(0);
  const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
  cell = await startFakeCell(device.key);
  environment.env.SECBOT_CELL_URL = cell.url;
  return { environment, cell };
}

const MINUTE = 60_000;

/** The contract's example held call: a person ask-first rule on handoff, an api_key argument. */
const HELD: HeldCall = {
  number: 1,
  requestId: "conversation:call-1",
  agent: "lead",
  tool: "handoff",
  summary: "handoff -> research",
  arguments: {
    specialist: "research",
    brief: "Find direct trains to Leeds on Friday 10 Oct, leaving after 07:00.",
    api_key: "[redacted]",
  },
  reason: "your rule: lead handoff (any) -> ask first",
  reasonSource: "your-rule",
  always: {
    offered: true,
    rule: {
      agent: "lead",
      tool: "handoff",
      verdict: "permit",
      match: { kind: "exact", field: "specialist", value: "research" },
    },
    note: null,
  },
  heldAt: 0,
  expiresAt: 0,
  remainingMs: (23 * 60 + 58) * MINUTE,
  status: "pending",
};

const OWNER_HELD: HeldCall = {
  ...HELD,
  number: 2,
  summary: "handoff -> developer",
  arguments: { specialist: "developer", brief: "Fix the build." },
  reason: "owner rule: all handoff (specialist = developer) -> ask first",
  reasonSource: "owner-rule",
  always: {
    offered: false,
    rule: null,
    note: "allow always is not offered: an owner rule asks first here",
  },
  remainingMs: (21 * 60 + 10) * MINUTE,
};

/**
 * The contract's block (02c "Held call in `secbot chat`"). The time to lapse ends at column 78,
 * the same right edge as the dash rule and the other right-aligned lines.
 */
const BLOCK = [
  "[ HELD #1 ] the lead wants to run a tool                   lapses in 23 h 58 m",
  "  agent      lead",
  "  tool       handoff",
  "  arguments  specialist = research",
  '             brief = "Find direct trains to Leeds on Friday 10 Oct, leaving',
  '               after 07:00."',
  "             api_key = [redacted]",
  "  why held   your rule: lead handoff (any) -> ask first",
  "  answer     /allow 1     allow once",
  "             /always 1    allow always; adds: lead handoff",
  "                          (specialist = research) -> permit",
  "             /deny 1      deny",
];

/** Every line at most 80 columns, with no escape or other control character. */
const plainText = (text: string) =>
  text.split("\n").every((line) => line.length <= 80 && !/\p{Cc}/u.test(line));

describe("the held-call block", () => {
  it("prints the contract's block with the agent, tool, redacted arguments, reason, and answers", () => {
    expect(heldBlock(HELD, 1)).toEqual(BLOCK);
    expect(BLOCK[0]).toHaveLength(78);
  });

  it("numbers two held calls and replaces allow always under an owner rule", () => {
    const two = heldBlock(OWNER_HELD, 2);
    expect(two[0]).toBe(
      "[ HELD #2 of 2 ] the lead wants to run a tool              lapses in 21 h 10 m",
    );
    expect(two).toContain(
      "  why held   owner rule: all handoff (specialist = developer) -> ask first",
    );
    expect(two.slice(-3)).toEqual([
      "  answer     /allow 2     allow once",
      "             (allow always is not offered: an owner rule asks first here)",
      "             /deny 2      deny",
    ]);
    expect(two.join("\n")).not.toContain("/always 2");
  });

  it("keeps a long header inside 80 columns by moving the time to lapse to its own line", () => {
    const block = heldBlock({ ...HELD, agent: "household", summary: "handoff -> research" }, 2);
    expect(block.slice(0, 2)).toEqual([
      "[ HELD #1 of 2 ] the household specialist wants to run a tool",
      `${" ".repeat(59)}lapses in 23 h 58 m`,
    ]);
    expect(plainText(block.join("\n"))).toBe(true);
  });

  it("names the arguments left out of a long call instead of showing them", () => {
    const block = heldBlock(
      { ...HELD, arguments: { to: "ann@example.com", "\u2026dropped": ["body"] } },
      1,
    );
    expect(block).toContain("  arguments  to = ann@example.com");
    expect(block).toContain("  not shown  (too long): body");
    expect(block.join("\n")).not.toContain("dropped");
  });

  it("shows control and format characters from an agent as ?", () => {
    const block = heldBlock(
      { ...HELD, tool: "send\u001b[2Jmail", arguments: { to: "evil\u202Emoc.example" } },
      1,
    );
    expect(block).toContain("  tool       send?[2Jmail");
    expect(block).toContain("  arguments  to = evil?moc.example");
    for (const line of block) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("takes only an exact /allow N, /always N, or /deny N as an answer", () => {
    expect(answerOf("/allow 1")).toEqual({ kind: "answer", choice: "allow", number: 1 });
    expect(answerOf("/always 12")).toEqual({ kind: "answer", choice: "always", number: 12 });
    expect(answerOf("/deny 3")).toEqual({ kind: "answer", choice: "deny", number: 3 });
    for (const line of ["/allow", "/allow one", "/ALLOW 1", "/deny 1 now", "/always 0"]) {
      expect(answerOf(line)).toEqual({ kind: "malformed" });
    }
    for (const line of ["allow 1", "yes, allow it", "please /allow 1", "/allowance"]) {
      expect(answerOf(line).kind).not.toBe("answer");
    }
    expect(answerOf("allow 1")).toEqual({ kind: "message" });
  });
});

describe("secbot chat with a held call", () => {
  it("shows the block, sends a plain line to the lead, refuses a malformed answer, and answers /allow 1", async () => {
    const { environment, cell: fake } = await setup();
    fake.answers[1] = [
      200,
      {
        number: 1,
        status: "allowed",
        answer: "allow",
        agent: "lead",
        tool: "handoff",
        summary: "handoff -> research",
        answeredBy: "sam",
        rule: null,
      },
    ];
    fake.onInput = (input, socket) => {
      if (input.text === "find trains to Leeds") {
        socket.send({ type: "delta", text: "Let me ask research." });
        socket.send({ type: "held", call: HELD, count: 1 });
      } else {
        socket.send({ type: "delta", text: `noted: ${input.text}` });
        socket.send({ type: "answer", entryId: 9, text: `noted: ${input.text}` });
      }
    };
    const { io, out, err } = testIo(async function* (output) {
      yield "find trains to Leeds";
      await waitFor(() => output().includes("[ HELD #1 ]"));
      yield "are you still there?";
      await waitFor(() => output().includes("noted: are you still there?"));
      yield "/allow one";
      yield "/allow 1";
      await waitFor(() => output().includes("[ allowed once ]"));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    expect(out()).toBe(
      [
        "connected to owner lead",
        "Let me ask research.",
        "",
        ...BLOCK,
        "noted: are you still there?",
        "[ allowed once ] #1 handoff -> research",
        "",
      ].join("\n"),
    );
    expect(err()).toBe("not sent: answer with /allow N, /always N, or /deny N\n");
    // Only the two plain lines reached the lead; the answer went to the approval route.
    expect(fake.inputs.map((input) => input.text)).toEqual([
      "find trains to Leeds",
      "are you still there?",
    ]);
    expect(fake.calls.filter((call) => call.path.includes("/approvals/"))).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/cells/owner/approvals/1",
        body: { answer: "allow" },
      }),
    ]);
    expect(plainText(out())).toBe(true);
  });

  it("prints every confirmation: always, deny, lapsed, not offered, and an unknown number", async () => {
    const { environment, cell: fake } = await setup();
    const base = {
      agent: "lead",
      tool: "handoff",
      summary: "handoff -> research",
      answeredBy: "sam",
    };
    fake.answers[1] = [
      200,
      {
        ...base,
        number: 1,
        status: "always",
        answer: "always",
        rule: HELD.always.rule,
      },
    ];
    fake.answers[2] = [
      400,
      { error: "refused: allow always is not offered: an owner rule asks first here" },
    ];
    fake.answers[4] = [200, { ...base, number: 4, status: "denied", answer: "deny", rule: null }];
    fake.answers[5] = [409, { error: "lapsed" }];
    const { io, out } = testIo(async function* (output) {
      yield "/always 1";
      await waitFor(() => output().includes("(specialist = research) -> permit"));
      yield "/always 2";
      await waitFor(() => output().includes("[ not offered ]"));
      yield "/deny 4";
      await waitFor(() => output().includes("[ denied ]"));
      yield "/allow 5";
      await waitFor(() => output().includes("[ lapsed ]"));
      yield "/allow 3";
      await waitFor(() => output().includes("no held call #3"));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    expect(out()).toBe(
      [
        "connected to owner lead",
        "[ allowed always ] #1 handoff -> research; added rule: lead handoff",
        "  (specialist = research) -> permit",
        "[ not offered ] #2 allow always is not offered: an owner rule asks first here",
        '[ denied ] #4 handoff -> research; the lead was told "denied by sam"',
        "[ lapsed ] #5 this request lapsed; nobody answered in 24 h",
        "no held call #3",
        "",
      ].join("\n"),
    );
    expect(fake.inputs).toEqual([]);
    expect(plainText(out())).toBe(true);
  });

  it("shows two held calls with their numbers and count, each once", async () => {
    const { environment, cell: fake } = await setup();
    fake.onInput = (_input, socket) => {
      socket.send({ type: "held", call: HELD, count: 2 });
      socket.send({ type: "held", call: OWNER_HELD, count: 2 });
      socket.send({ type: "held", call: HELD, count: 2 });
    };
    const { io, out } = testIo(async function* (output) {
      yield "two things please";
      await waitFor(() => output().includes("[ HELD #2 of 2 ]"));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    expect(out().match(/\[ HELD #1 of 2 \]/g)).toHaveLength(1);
    expect(out().match(/\[ HELD #2 of 2 \]/g)).toHaveLength(1);
    expect(plainText(out())).toBe(true);
  });
});

describe("secbot missed with a held call", () => {
  it("lists HELD CALLS first, then the missed messages", async () => {
    const { environment, cell: fake } = await setup();
    fake.held = [{ ...HELD, remainingMs: (21 * 60 + 10) * MINUTE }, OWNER_HELD];
    fake.missed = [{ kind: "answer", entryId: 3, text: "I asked research about trains." }];
    const { io, out } = testIo();
    expect(await run(["missed"], { environment, io })).toBe(0);
    expect(out()).toBe(
      [
        "HELD CALLS",
        "------------------------------------------------------------------------------",
        "#1  lead  handoff -> research  your rule: ask first        lapses in 21 h 10 m",
        "answer in secbot chat: /allow 1, /always 1, /deny 1",
        "#2  lead  handoff -> developer  owner rule: ask first      lapses in 21 h 10 m",
        "answer in secbot chat: /allow 2, /deny 2",
        "",
        "lead: I asked research about trains.",
        "",
      ].join("\n"),
    );
    expect(plainText(out())).toBe(true);
    const again = testIo();
    fake.held = [];
    expect(await run(["missed"], { environment, io: again.io })).toBe(0);
    expect(again.out()).toBe("no missed messages\n");
  });

  it("shows a held call first when the next chat opens", async () => {
    const { environment, cell: fake } = await setup();
    const { io, out } = testIo(async function* (output) {
      // The cell sends waiting calls right after connected, before missed messages.
      fake.sockets.at(-1)?.send({ type: "held", call: HELD, count: 1 });
      fake.sockets.at(-1)?.send({
        type: "missed",
        entryId: 4,
        from: null,
        text: "I asked research.",
        remaining: 0,
      });
      await waitFor(() => output().includes("lead: I asked research."));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    const lines = out().split("\n");
    expect(lines.slice(0, 3)).toEqual(["connected to owner lead", "", BLOCK[0]]);
    expect(lines.indexOf("lead: I asked research.")).toBeGreaterThan(lines.indexOf(BLOCK[0] ?? ""));
  });
});
