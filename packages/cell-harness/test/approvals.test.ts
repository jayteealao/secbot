// Held calls on the stand-in cell: a scripted faux model makes the tool calls, so every case runs
// the real guard hook, the real held-call records, and the real activity records. A controlled
// clock and timer stand in for the 24 hours.
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type HookApi,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityRecord } from "../src/activity.ts";
import {
  AlwaysNotOffered,
  HeldCallLapsed,
  LAPSED_TEXT,
  NOT_OFFERED_OWNER,
  type SetTimer,
  USED_TEXT,
} from "../src/approvals.ts";
import { ApprovalDoc, ApprovalsDoc, RosterDoc } from "../src/docs.ts";
import { HOLD_MS } from "../src/release-defaults.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";

/**
 * A message whose text starts with `CALL` lists tool calls, one per line: `CALL <tool> <json>`. The
 * role that receives it makes those calls; after the results it answers in plain text.
 */
function scripted(request: FauxRequest) {
  if (request.last?.role === "toolResult") {
    return fauxAssistantMessage([fauxText(`${request.role} done`)]);
  }
  if (!request.lastText.startsWith("CALL ")) {
    return fauxAssistantMessage([fauxText(`${request.role} says: ${request.lastText}`)]);
  }
  const calls = request.lastText.split("\n").map((line) => {
    const [, tool = "", json = "{}"] = /^CALL (\S+) ?(.*)$/.exec(line) ?? [];
    return fauxToolCall(tool, JSON.parse(json || "{}") as Record<string, JsonValue>);
  });
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

const CALL = (tool: string, args: Record<string, unknown> = {}) =>
  `CALL ${tool} ${JSON.stringify(args)}`;

/** A clock that moves only when told, and timers that fire when it passes them. */
function controlledClock(start = Date.UTC(2026, 9, 8, 12, 0)) {
  let now = start;
  const timers: { at: number; fire: () => void; done: boolean }[] = [];
  const setTimer: SetTimer = (ms, fire) => {
    const timer = { at: now + ms, fire, done: false };
    timers.push(timer);
    return () => {
      timer.done = true;
    };
  };
  return {
    now: () => now,
    setTimer,
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= now) {
          timer.done = true;
          timer.fire();
        }
      }
    },
  };
}

const SECRET = "sk-live-9876543210zyxwvutsrqp"; // gitleaks:allow (fake test token)

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

async function open(extra: Parameters<typeof openTestCell>[0] = {}) {
  test = await openTestCell({
    gateway: createFauxGateway(scripted),
    household: createHouseholdStub(),
    ...extra,
  });
  return test;
}

/** Tool results the lead's model saw, oldest first. */
const toolResults = (t: TestCell) =>
  t.gateway.requests
    .filter((r) => r.role === "lead" && r.last?.role === "toolResult")
    .map((r) => r.lastText);

// The guard's records: finished hand-off jobs also write a record (kind job), not counted here.
const records = async (t: TestCell): Promise<ActivityRecord[]> =>
  (await t.cell.activity({ limit: 200 })).records.filter((record) => record.kind !== "job");

const events = (spy: { mock: { calls: unknown[][] } }, name: string) =>
  loggedEvents(spy.mock.calls).filter((event) => event.event === name);

const reporters = async (t: TestCell) =>
  Object.keys((await t.cell.harness.snapshot(RosterDoc, BACKGROUND_CONTEXT))?.reporters ?? {})
    .length;

const LEAD_ASKS_HANDOFF = { agent: "lead", tool: "handoff", verdict: "ask-first" } as const;

describe("a held call", () => {
  it("waits for the person: a chat line is queued, allow once runs it once, deny refuses with the person's name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(
      CALL("handoff", { specialist: "research", brief: "Find trains.", api_key: SECRET }),
      "c-1",
    );
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const [held] = await t.cell.heldCalls();
    expect(held).toMatchObject({
      number: 1,
      agent: "lead",
      tool: "handoff",
      summary: "handoff -> research",
      arguments: { specialist: "research", brief: "Find trains.", api_key: "[redacted]" },
      reason: "your rule: lead handoff (any) -> ask first",
      reasonSource: "your-rule",
      status: "pending",
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
    });
    expect(held?.expiresAt).toBe((held?.heldAt ?? 0) + HOLD_MS);
    expect(events(log, "approval.held")).toEqual([
      expect.objectContaining({ cell: "owner", role: "lead", tool: "handoff", call_no: 1 }),
    ]);

    // A plain chat line while the call is held goes to the lead (queued), and is not an answer.
    const queued = await t.cell.submit("are you still there?", "c-2");
    expect(queued.id).toBeDefined();
    expect((await t.cell.heldCalls()).map((call) => call.number)).toEqual([1]);
    expect(await reporters(t)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.gateway.requests.some((r) => r.lastText.includes("are you still there?"))).toBe(false);
    expect((await t.cell.heldCalls()).map((call) => call.status)).toEqual(["pending"]);

    await t.cell.answer(1, "allow", { device: "laptop" });
    await until(async () => (await reporters(t)) === 1);
    await until(() => t.gateway.requests.some((r) => r.lastText.includes("are you still there?")));
    expect(toolResults(t)[0]).not.toContain("blocked");
    expect(await reporters(t)).toBe(1);
    expect(events(log, "approval.answered")).toEqual([
      expect.objectContaining({ answer: "allow", late: false, device: "laptop", call_no: 1 }),
    ]);

    // A second held call, denied.
    await t.cell.submit(CALL("handoff", { specialist: "health", brief: "Sleep tips." }), "c-3");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    await t.cell.answer(2, "deny", { device: "laptop" });
    await until(() => toolResults(t).some((text) => text.includes("denied by owner")));
    expect(toolResults(t).at(-1)).toContain("Tool call blocked: denied by owner");
    expect(await reporters(t)).toBe(1);

    const all = await records(t);
    expect(all.filter((r) => r.kind === "held").map((r) => [r.number, r.verdict, r.layer])).toEqual(
      [
        [2, "held", "rule"],
        [1, "held", "rule"],
      ],
    );
    expect(
      all.filter((r) => r.kind === "answered").map((r) => [r.number, r.verdict, r.layer, r.reason]),
    ).toEqual([
      [2, "denied", "person", "denied by owner"],
      [1, "allowed", "person", "allowed once by owner"],
    ]);
  });

  it("allow always runs the call, adds the person rule, and the next match is not held; under an owner ask-first rule it is not offered", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "One." }), "a-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const answered = await t.cell.answer(1, "always", { device: "laptop" });
    expect(answered.rule).toMatchObject({
      agent: "lead",
      tool: "handoff",
      verdict: "permit",
      source: "allow-always",
      match: { kind: "exact", field: "specialist", value: "research" },
    });
    await until(async () => (await reporters(t)) === 1);
    expect((await t.cell.rules()).person.filter((r) => r.source === "allow-always")).toHaveLength(
      1,
    );
    expect(events(log, "rules.changed")).toContainEqual(
      expect.objectContaining({ action: "add", outcome: "done", level: "person" }),
    );

    // The next matching call is decided by the added rule: no hold, a verdict on layer rule.
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "Two." }), "a-2");
    await until(async () => (await reporters(t)) === 2);
    const [newest] = await records(t);
    expect(newest).toMatchObject({
      kind: "verdict",
      verdict: "allowed",
      layer: "rule",
      reason: "your rule: lead handoff (specialist = research) -> permit",
    });
    expect((await t.cell.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.nextNumber).toBe(2);

    // An owner ask-first rule: allow always is not offered, and refused when asked for.
    await t.cell.addRule("owner", {
      agent: "all",
      tool: "handoff",
      verdict: "ask-first",
      match: { kind: "exact", field: "specialist", value: "developer" },
    });
    await t.cell.submit(CALL("handoff", { specialist: "developer", brief: "Three." }), "a-3");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const [owner] = await t.cell.heldCalls();
    expect(owner).toMatchObject({
      number: 2,
      reasonSource: "owner-rule",
      reason: "owner rule: all handoff (specialist = developer) -> ask first",
      always: { offered: false, rule: null, note: NOT_OFFERED_OWNER },
    });
    await expect(t.cell.answer(2, "always", { device: "laptop" })).rejects.toBeInstanceOf(
      AlwaysNotOffered,
    );
    expect((await t.cell.heldCalls()).map((call) => call.number)).toEqual([2]);
    await t.cell.answer(2, "allow", { device: "laptop" });
    await until(async () => (await reporters(t)) === 3);
    expect((await t.cell.rules()).person.filter((r) => r.source === "allow-always")).toHaveLength(
      1,
    );
  });

  it("offers allow always for a reminder the person's own rule held, and only allow once and deny for a card number or a secret word", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await t.cell.addRule("person", { agent: "lead", tool: "set_reminder", verdict: "ask-first" });
    await t.cell.submit(CALL("set_reminder", { text: "bins out", at }), "r-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const [own] = await t.cell.heldCalls();
    // The owner card-number rule does not accept "bins out", so allow always stays on offer.
    expect(own).toMatchObject({
      reasonSource: "your-rule",
      always: {
        offered: true,
        rule: {
          agent: "lead",
          tool: "set_reminder",
          verdict: "permit",
          match: { kind: "exact", field: "text", value: "bins out" },
        },
        note: null,
      },
    });
    const answered = await t.cell.answer(own?.number ?? 0, "always", { device: "laptop" });
    expect(answered.rule).toMatchObject({ source: "allow-always", tool: "set_reminder" });

    // A card number in a reminder: held by the owner rule, allow always not offered.
    await t.cell.submit(
      CALL("set_reminder", { text: "pay with card 4111 1111 1111 1111", at }),
      "r-2",
    );
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const [card] = await t.cell.heldCalls();
    expect(card).toMatchObject({
      reasonSource: "owner-rule",
      always: { offered: false, rule: null, note: NOT_OFFERED_OWNER },
    });
    expect(card?.reason).toMatch(/^owner rule: all set_reminder \(text ~ /);
    await expect(
      t.cell.answer(card?.number ?? 0, "always", { device: "laptop" }),
    ).rejects.toBeInstanceOf(AlwaysNotOffered);
    await t.cell.answer(card?.number ?? 0, "deny", { device: "laptop" });
    await until(async () => (await t.cell.heldCalls()).length === 0);

    // A secret word in a history search: the same.
    await t.cell.submit(CALL("search_history", { query: "my bank PIN" }), "r-3");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const [word] = await t.cell.heldCalls();
    expect(word).toMatchObject({
      tool: "search_history",
      reasonSource: "owner-rule",
      always: { offered: false, rule: null, note: NOT_OFFERED_OWNER },
    });
    await t.cell.answer(word?.number ?? 0, "deny", { device: "laptop" });
    await until(async () => (await t.cell.heldCalls()).length === 0);

    // A routine search runs with no hold.
    await t.cell.submit(CALL("search_history", { query: "spinach" }), "r-4");
    await until(async () =>
      (await records(t)).some((r) => r.kind === "verdict" && r.tool === "search_history"),
    );
    expect(await t.cell.heldCalls()).toEqual([]);
  });
});

describe("binding an answer to its request", () => {
  it("does not ask again for a retry under the same request id, and refuses a used or denied answer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // The request id comes from a test argument, so the model can retry under the same id.
    const t = await open({
      guard: { requestIdOf: (call, api) => String(call.arguments.rid ?? api.conversationId) },
    });
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    const call = CALL("handoff", { specialist: "research", brief: "Trains.", rid: "R-1" });
    await t.cell.submit(call, "b-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    await t.cell.answer(1, "allow", { device: "laptop" });
    await until(async () => (await reporters(t)) === 1);
    await until(() => toolResults(t).length === 1);

    // The retry under R-1 with the same arguments: no second prompt; the allow-once is used.
    await t.cell.submit(call, "b-2");
    await until(() => toolResults(t).length === 2);
    expect(toolResults(t)[1]).toContain(`Tool call blocked: ${USED_TEXT}`);
    expect(events(log, "approval.held")).toHaveLength(1);
    expect(await reporters(t)).toBe(1);

    // Denied under R-2, then retried: refused with the denial, no prompt.
    const denied = CALL("handoff", { specialist: "health", brief: "Sleep.", rid: "R-2" });
    await t.cell.submit(denied, "b-3");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    await t.cell.answer(2, "deny", { device: "laptop" });
    await until(() => toolResults(t).length === 3);
    await t.cell.submit(denied, "b-4");
    await until(() => toolResults(t).length === 4);
    expect(toolResults(t)[3]).toContain("Tool call blocked: denied by owner");
    expect(events(log, "approval.held")).toHaveLength(2);
    const [retry] = await records(t);
    expect(retry).toMatchObject({ kind: "verdict", verdict: "refused", layer: "person" });
  });

  it("holds other arguments again, and lets only one of two concurrent calls use one allow-once answer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open({ guard: { requestIdOf: () => "R" } });
    await t.cell.addRule("person", {
      agent: "lead",
      tool: "search_history",
      verdict: "ask-first",
    });
    const guard = beforeToolOf(t.cell.extensions.lead[0]);
    const call = (id: string, query: string) => ({
      type: "toolCall" as const,
      id,
      name: "search_history",
      arguments: { query },
    });
    const first = guard(call("c-1", "kale"), hookApi(t, "task-1"), BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.heldCalls()).length === 1);
    // The same request id and arguments from another call waits on the same record.
    const second = guard(call("c-2", "kale"), hookApi(t, "task-2"), BACKGROUND_CONTEXT);
    // The same request id with other arguments is a new held call.
    const other = guard(call("c-3", "beans"), hookApi(t, "task-3"), BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.heldCalls()).length === 2);
    expect((await t.cell.heldCalls()).map((held) => held.number)).toEqual([1, 2]);
    expect(events(log, "approval.held")).toHaveLength(2);

    await t.cell.answer(1, "allow", { device: "laptop" });
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.filter((result) => result?.block === USED_TEXT)).toHaveLength(1);
    const record = await t.cell.harness.snapshot(ApprovalDoc, "1", BACKGROUND_CONTEXT);
    expect(["task-1:c-1", "task-2:c-2"]).toContain(record?.call?.consumedBy);

    await t.cell.answer(2, "deny", { device: "laptop" });
    expect(await other).toEqual({ block: "denied by owner" });
  });
});

describe("lapse after 24 hours", () => {
  it("lapses an unanswered call as a refusal, refuses a late answer, and runs a call answered before 24 h", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = controlledClock();
    const t = await open({ now: clock.now, guard: { setTimer: clock.setTimer } });
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "Late." }), "l-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    clock.advance(HOLD_MS);
    await until(() => toolResults(t).length === 1);
    expect(toolResults(t)[0]).toContain(`Tool call blocked: ${LAPSED_TEXT}`);
    expect(await reporters(t)).toBe(0);
    const [lapsed] = await records(t);
    expect(lapsed).toMatchObject({
      kind: "lapsed",
      number: 1,
      verdict: "lapsed",
      layer: "person",
      reason: "no answer in 24 h; refused",
    });
    expect(events(log, "approval.lapsed")).toEqual([
      expect.objectContaining({ call_no: 1, cause: "expired", held_ms: HOLD_MS }),
    ]);
    await expect(t.cell.answer(1, "allow", { device: "laptop" })).rejects.toBeInstanceOf(
      HeldCallLapsed,
    );
    expect(events(log, "approval.answered")).toEqual([
      expect.objectContaining({ call_no: 1, late: true }),
    ]);

    // Answered at 23 h 59 m: it runs.
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "Early." }), "l-2");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    clock.advance(HOLD_MS - 60_000);
    await t.cell.answer(2, "allow", { device: "laptop" });
    await until(async () => (await reporters(t)) === 1);
  });

  it("lapses a call whose 24 hours passed while the cell was closed, when the hook runs again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = controlledClock();
    const t = await open({ now: clock.now, guard: { setTimer: clock.setTimer } });
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "Closed." }), "z-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    // Closing aborts the waiting hook, but that is not an aborted job: the call stays pending.
    await t.cell.close();
    test = undefined;
    clock.advance(HOLD_MS + 1);
    const reopened = await open({
      storage: t.storage,
      now: clock.now,
      guard: { setTimer: clock.setTimer },
    });
    await until(async () => {
      const record = await reopened.cell.harness.snapshot(ApprovalDoc, "1", BACKGROUND_CONTEXT);
      return record?.call?.status === "lapsed";
    });
    const record = await reopened.cell.harness.snapshot(ApprovalDoc, "1", BACKGROUND_CONTEXT);
    expect(record?.call?.lapseCause).toBe("expired");
    expect(await reopened.cell.heldCalls()).toEqual([]);
  });
});

describe("precedence and aborts", () => {
  it("refuses an allowed call that an owner prohibit added during the wait matches", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "X." }), "p-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    await t.cell.addRule("owner", {
      agent: "all",
      tool: "handoff",
      verdict: "prohibit",
      match: { kind: "exact", field: "specialist", value: "research" },
    });
    await t.cell.answer(1, "allow", { device: "laptop" });
    await until(() => toolResults(t).length === 1);
    expect(toolResults(t)[0]).toContain(
      "Tool call blocked: owner rule: all handoff (specialist = research) -> prohibit",
    );
    expect(await reporters(t)).toBe(0);
    const [refused] = await records(t);
    expect(refused).toMatchObject({ kind: "verdict", verdict: "refused", layer: "rule" });
  });

  it("lapses the held call at once when the agent's job is aborted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(CALL("handoff", { specialist: "research", brief: "Stop." }), "x-1");
    await until(async () => (await t.cell.heldCalls()).length === 1);
    await t.cell.root.abort(BACKGROUND_CONTEXT);
    await until(async () => {
      const record = await t.cell.harness.snapshot(ApprovalDoc, "1", BACKGROUND_CONTEXT);
      return record?.call?.status === "lapsed";
    });
    const record = await t.cell.harness.snapshot(ApprovalDoc, "1", BACKGROUND_CONTEXT);
    expect(record?.call?.lapseCause).toBe("aborted");
    expect((await records(t))[0]).toMatchObject({
      kind: "lapsed",
      reason: "the agent's job was aborted; refused",
    });
    expect(events(log, "approval.lapsed")).toEqual([
      expect.objectContaining({ call_no: 1, cause: "aborted" }),
    ]);
    expect(await reporters(t)).toBe(0);
  });
});

describe("other work while a call is held (the cell's half)", () => {
  it("keeps the lead, another specialist, and a reminder working while a specialist's call waits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    await t.cell.addRule("person", {
      agent: "research",
      tool: "search_history",
      verdict: "ask-first",
    });
    await t.cell.submit(
      CALL("handoff", { specialist: "research", brief: CALL("search_history", { query: "x" }) }),
      "o-1",
    );
    await until(async () => (await t.cell.heldCalls()).length === 1);
    const [held] = await t.cell.heldCalls();
    expect(held).toMatchObject({ agent: "research", tool: "search_history" });

    // The lead answers a chat line; another specialist's job finishes; a reminder fires.
    const at = new Date(Date.now() + 700).toISOString();
    await t.cell.submit(
      [
        CALL("handoff", { specialist: "household", brief: CALL("household_read", {}) }),
        CALL("set_reminder", { at, text: "bins out" }),
      ].join("\n"),
      "o-2",
    );
    await t.cell.submit("hello lead", "o-3");
    await until(() =>
      t.gateway.requests.some((r) => r.role === "household" && r.last?.role === "toolResult"),
    );
    // The reminder routine fires at its time and reaches the lead as a reminder message.
    await until(() =>
      t.gateway.requests.some(
        (r) => r.role === "lead" && r.lastText.startsWith("[reminder] bins out"),
      ),
    );
    await until(() =>
      t.gateway.requests.some((r) => r.role === "lead" && r.lastText === "hello lead"),
    );
    expect((await t.cell.heldCalls()).map((call) => call.number)).toEqual([1]);
    await t.cell.answer(1, "deny", { device: "laptop" });
  });
});

describe("redaction", () => {
  it("keeps a secret argument out of the record, the activity, and every event; the binding is a digest", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await open();
    await t.cell.addRule("person", LEAD_ASKS_HANDOFF);
    await t.cell.submit(
      CALL("handoff", { specialist: "research", brief: "Go.", api_key: SECRET }),
      "s-1",
    );
    await until(async () => (await t.cell.heldCalls()).length === 1);
    await t.cell.answer(1, "deny", { device: "laptop" });
    await until(() => toolResults(t).length === 1);
    const record = await t.cell.harness.snapshot(ApprovalDoc, "1", BACKGROUND_CONTEXT);
    expect(record?.call?.digest).toMatch(/^[0-9a-f]{64}$/);
    const everything = JSON.stringify([
      record,
      await records(t),
      await t.cell.heldCalls(),
      loggedEvents(log.mock.calls),
    ]);
    expect(everything).toContain("[redacted]");
    expect(everything).not.toContain(SECRET);
  });
});

function beforeToolOf(extension: unknown): ToolHooks["beforeTool"] {
  const hooks = (extension as { hooks?: { handlers: object }[] }).hooks ?? [];
  const handlers = hooks[0]?.handlers as Partial<ToolHooks> | undefined;
  if (handlers?.beforeTool === undefined) throw new Error("no beforeTool hook");
  const bound = handlers.beforeTool.bind(handlers);
  return (call, api, context: Context) => bound(call, api, context);
}

function hookApi(t: TestCell, taskId: string): HookApi {
  const harness = t.cell.harness;
  return {
    taskId: taskId as unknown as TaskId,
    conversationId: ROOT_CONVERSATION_ID as ConversationId,
    snapshot: harness.snapshot.bind(harness),
    snapshotAsOf: harness.snapshotAsOf.bind(harness),
    memo: (() => Promise.resolve(undefined)) as HookApi["memo"],
  } as HookApi;
}
