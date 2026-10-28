// The loop guard's pure parts: near-same tool arguments, the failing-step streak read from a
// request's messages, and the projected cost of the next step.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { failingStreak, nearSame, normalizeArgs, projectNext } from "../src/loop-guard.ts";
import { EMPTY_REPLY_NUDGE } from "../src/release-defaults.ts";

let ids = 0;

const usage = (cost: number) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  cost = 0.01,
): Message =>
  ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "faux",
    usage: usage(cost),
    stopReason,
    timestamp: 0,
  }) as Message;

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

/** One tool round: the assistant's call and its result. */
const call = (name: string, args: Record<string, unknown>, isError = true): Message[] => {
  const id = `call-${++ids}`;
  return [
    assistant([{ type: "toolCall", id, name, arguments: args as never }], "toolUse"),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: isError ? "failed" : "ok" }],
      isError,
      timestamp: 0,
    } as Message,
  ];
};

const LONG = "cheapest direct flights from london to lisbon departing on 2026-05-12 economy";

describe("near-same arguments", () => {
  it("normalizes key order, case, and whitespace", () => {
    expect(normalizeArgs({ b: " Hello   World ", a: [1, { z: "X", y: "y" }] })).toBe(
      normalizeArgs({ a: [1, { y: "Y", z: "x" }], b: "hello world" }),
    );
  });

  it("counts one changed date in a long query, and not a different tool or short argument", () => {
    const a = { name: "household_read", args: { query: LONG } };
    const b = { name: "household_read", args: { query: LONG.replace("12", "13") } };
    expect(nearSame(a, b)).toBe(true);
    expect(nearSame(a, { name: "search_history", args: { query: LONG } })).toBe(false);
    expect(
      nearSame(
        { name: "household_read", args: { document: "shopping" } },
        { name: "household_read", args: { document: "chores" } },
      ),
    ).toBe(false);
  });
});

describe("the failing-step streak", () => {
  it("counts a true repeat: the same failing call three times", () => {
    const messages = [
      user("brief"),
      ...call("household_read", { document: "shopping" }),
      ...call("household_read", { document: "shopping" }),
      ...call("household_read", { document: "shopping" }),
    ];
    expect(failingStreak(messages)).toBe(3);
  });

  it("counts a near miss in a long argument, and resets on another tool or short argument", () => {
    expect(
      failingStreak([
        user("brief"),
        ...call("household_read", { query: LONG }),
        ...call("household_read", { query: LONG.replace("12", "13") }),
        ...call("household_read", { query: LONG.replace("12", "14") }),
      ]),
    ).toBe(3);
    expect(
      failingStreak([
        ...call("household_read", { query: LONG }),
        ...call("household_read", { query: LONG }),
        ...call("search_history", { query: LONG }),
      ]),
    ).toBe(1);
    expect(
      failingStreak([
        ...call("household_read", { document: "shopping" }),
        ...call("household_read", { document: "shopping" }),
        ...call("household_read", { document: "chores" }),
      ]),
    ).toBe(1);
  });

  it("ends the streak on a successful step or a new input", () => {
    expect(
      failingStreak([
        ...call("household_read", { document: "shopping" }),
        ...call("household_read", { document: "shopping" }, false),
        ...call("household_read", { document: "shopping" }),
      ]),
    ).toBe(1);
    expect(
      failingStreak([
        ...call("household_read", { document: "shopping" }),
        user("The lead answers: try the other list"),
        ...call("household_read", { document: "shopping" }),
      ]),
    ).toBe(1);
  });

  it("counts three empty replies, with the nudge between them", () => {
    const empty = assistant([]);
    expect(
      failingStreak([
        user("brief"),
        empty,
        user(EMPTY_REPLY_NUDGE),
        empty,
        user(EMPTY_REPLY_NUDGE),
        assistant([{ type: "text", text: "   " }]),
      ]),
    ).toBe(3);
  });

  it("counts a cut-off reply", () => {
    expect(
      failingStreak([
        user("brief"),
        assistant([{ type: "text", text: "The cheapest flights are" }], "length"),
        user(EMPTY_REPLY_NUDGE),
        assistant([{ type: "text", text: "The cheap" }], "length"),
      ]),
    ).toBe(2);
  });

  it("never counts a provider failure (429 or 402) and leaves the streak unchanged", () => {
    const refused = (status: number) =>
      ({
        ...assistant([], "error"),
        errorMessage: `${status} rate limited`,
      }) as Message;
    expect(
      failingStreak([
        user("brief"),
        ...call("household_read", { document: "shopping" }),
        refused(429),
        refused(402),
        ...call("household_read", { document: "shopping" }),
      ]),
    ).toBe(2);
    expect(failingStreak([user("brief"), refused(429), refused(402)])).toBe(0);
  });

  it("is zero for a fresh job and after a real answer", () => {
    expect(failingStreak([user("brief")])).toBe(0);
    expect(failingStreak([user("brief"), assistant([{ type: "text", text: "done" }])])).toBe(0);
  });
});

describe("the next step's projected cost", () => {
  it("is the largest step so far, or 0", () => {
    expect(projectNext([user("brief")])).toBe(0);
    expect(
      projectNext([
        user("brief"),
        ...call("household_read", {}),
        assistant([{ type: "text", text: "x" }], "stop", 0.05),
        assistant([{ type: "text", text: "y" }], "stop", 0.02),
      ]),
    ).toBe(0.05);
  });
});
