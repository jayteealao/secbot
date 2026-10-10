// Limits on the wired paths of a cell on the stand-in. The month's spend by layer and role equals
// what the provider billed for each model response (a failed attempt included), each decision-model
// answer, and each reviewer answer; above the limit a hand-off's brief, a reminder, a routine run,
// and a specialist's next model request wait while chat with the lead is answered, a wait survives a
// reopen, and each continues once after a raise or the month reset; and a 402 or 403 to a guard call
// puts the cell in the credit pause without a crash.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetTimer } from "../src/approvals.ts";
import type { BudgetWaiter } from "../src/budget-gate.ts";
import { createDecisionModels, type DecisionModels } from "../src/decision-model.ts";
import { leadMessageOf } from "../src/delivery.ts";
import { WAITS_NOTE } from "../src/handoff.ts";
import { costOnlyUsage } from "../src/month-ledger.ts";
import { defineRoutine } from "../src/routines.ts";
import {
  addSpend,
  createFauxGateway,
  describeRequest,
  type FauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  isReviewerRequest,
  loggedEvents,
  openTestCell,
  reviewerResponder,
  type TestCell,
  until,
  verdictJson,
} from "./fixtures.ts";
import { ALERT_ENV, incidentStub } from "./outage-fixtures.ts";
import { BRIEF, handoffResponder } from "./responders.ts";
import { riskyAt, startStubOpenRouter } from "./stub-openrouter.ts";

const KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)
const CREDIT_402 =
  '402 {"error":{"code":402,"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits"}}';

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

async function leadTexts(t: TestCell): Promise<string[]> {
  const page = await t.cell.root.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  return [...page.items]
    .reverse()
    .map((entry: EntryRecord) => leadMessageOf(entry)?.text)
    .filter((text): text is string => text !== undefined);
}

const requestsOf = (gateway: FauxGateway, role: string) =>
  gateway.requests.filter((request) => request.role === role && !isReviewerRequest(request));

/**
 * Bills every faux response a known amount, as a provider does in `usage.cost` (pi-ai's faux
 * provider prices nothing): `price(request, message)` in USD. Keeps a tally per role and per
 * kind (agent or reviewer) as the oracle. Sits outside the credit-pause decorator, like the cost a
 * provider reports on the wire.
 */
function billed(
  gateway: FauxGateway,
  respond: (request: FauxRequest) => AssistantMessage | Promise<AssistantMessage>,
  price: (request: FauxRequest, message: AssistantMessage) => number,
) {
  const tally = { agent: {} as Record<string, number>, reviewer: 0, failed: 0 };
  gateway.respond = respond;
  const provider = gateway.models.getProvider("openrouter");
  if (provider === undefined) throw new Error("no openrouter provider");
  const bill = (
    inner: AssistantMessageEventStream,
    request: FauxRequest,
  ): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of inner) {
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          const usd = price(request, message);
          const priced: AssistantMessage = {
            ...message,
            usage: { ...message.usage, cost: { ...message.usage.cost, total: usd } },
          };
          if (isReviewerRequest(request)) tally.reviewer += usd;
          else tally.agent[request.role] = (tally.agent[request.role] ?? 0) + usd;
          if (message.stopReason === "error") tally.failed += usd;
          outer.push(
            event.type === "done" ? { ...event, message: priced } : { ...event, error: priced },
          );
        } else {
          outer.push(event);
        }
      }
      outer.end();
    })();
    return outer;
  };
  gateway.models.setProvider({
    ...provider,
    stream: (model, context, options) =>
      bill(provider.stream(model, context, options), describeRequest(context, model.id)),
    streamSimple: (model, context, options) =>
      bill(provider.streamSimple(model, context, options), describeRequest(context, model.id)),
  } as typeof provider);
  return tally;
}

describe("the month's spend from the ledger", () => {
  it("equals what was billed per layer and per role: model responses (a failed one included), decision answers, and reviewer answers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let decisions = 0;
    // A decision model that marks every call for review and bills $0.004 an answer.
    const marking: DecisionModels = (adapter) => ({
      adapter,
      ask: async () => {
        decisions++;
        return {
          outcome: "mark",
          choice: "risky",
          score: 0.9,
          model: "stand-in",
          costUsd: 0.004,
          usage: costOnlyUsage(0.004),
          durationMs: 1,
        };
      },
    });
    let failedOnce = false;
    const lead = (request: FauxRequest): AssistantMessage => {
      if (request.role === "lead") {
        if (!failedOnce) {
          failedOnce = true;
          return fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "503 Service Unavailable",
          });
        }
        if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("done")]);
        if (request.lastText.startsWith("CALL ")) {
          return fauxAssistantMessage([fauxToolCall("search_history", { query: "kale" })], {
            stopReason: "toolUse",
          });
        }
        return handoffResponder(request);
      }
      return handoffResponder(request);
    };
    const gateway = createFauxGateway();
    test = await openTestCell({ gateway, guard: { decision: marking, reviewerTimeoutMs: 2_000 } });
    const tally = billed(
      gateway,
      reviewerResponder(() => verdictJson("allow", "an ordinary call"), lead),
      (request, message) =>
        message.stopReason === "error" ? 0.02 : isReviewerRequest(request) ? 0.03 : 0.05,
    );
    const t = test;
    await (await t.cell.submit("CALL search", "ledger-1")).wait(BACKGROUND_CONTEXT);
    await (await t.cell.submit("Find out about fasting for me", "ledger-2")).wait(
      BACKGROUND_CONTEXT,
    );
    await until(async () => (await leadTexts(t)).some((text) => text.startsWith("Research says")));
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);

    expect(tally.failed).toBeCloseTo(0.02, 10);
    expect(decisions).toBeGreaterThanOrEqual(2);
    const cost = await t.cell.cost();
    const agent = Object.values(tally.agent).reduce((sum, usd) => sum + usd, 0);
    expect(cost.byLayer.agent).toBeCloseTo(agent, 10);
    expect(cost.byLayer.decision).toBeCloseTo(0.004 * decisions, 10);
    expect(cost.byLayer.reviewer).toBeCloseTo(tally.reviewer, 10);
    expect(cost.spentUsd).toBeCloseTo(agent + 0.004 * decisions + tally.reviewer, 10);
    // Per role: each role's own responses plus the guard calls its tool calls made.
    const activity = await t.cell.activity();
    const guardByRole: Record<string, number> = {};
    for (const item of activity.records) {
      // A job record carries the specialist's spend for the job, not a guard cost.
      if (item.kind === "job") continue;
      guardByRole[item.agent] = (guardByRole[item.agent] ?? 0) + item.cost;
    }
    for (const role of Object.keys(tally.agent)) {
      expect(cost.byRole[role]).toBeCloseTo(
        (tally.agent[role] ?? 0) + (guardByRole[role] ?? 0),
        10,
      );
    }
    // The independently logged model costs agree with the agent layer.
    const logged = loggedEvents(log.mock.calls)
      .filter((line) => line.event === "model.call")
      .reduce((sum, line) => sum + Number(line.cost_usd ?? 0), 0);
    expect(logged).toBeCloseTo(agent, 10);
  }, 30_000);
});

describe("above the limit only chat runs", () => {
  it("holds a hand-off's brief, answers chat, keeps the wait across a reopen, and delivers once after a raise", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(handoffResponder) });
    const t = test;
    await t.cell.setLimit(1, "owner");
    await addSpend(t.cell, 1.2);
    await (await t.cell.submit("Find out about fasting for me", "wait-1")).wait(BACKGROUND_CONTEXT);
    const toolResult = t.gateway.requests.find(
      (request) => request.role === "lead" && request.last?.role === "toolResult",
    );
    expect(toolResult?.lastText).toContain(WAITS_NOTE.slice(2));
    await until(async () => (await t.cell.waiting()).length === 1);
    expect(await t.cell.waiting()).toEqual([
      expect.objectContaining({
        budget: "person",
        what: `handoff research ${BRIEF.slice(0, 30).trimEnd()}`,
      }),
    ]);
    expect(requestsOf(t.gateway, "research")).toHaveLength(0);

    const leadBefore = requestsOf(t.gateway, "lead").length;
    await (await t.cell.submit("What is on today?", "wait-2")).wait(BACKGROUND_CONTEXT);
    expect(requestsOf(t.gateway, "lead").length).toBeGreaterThan(leadBefore);
    expect(requestsOf(t.gateway, "research")).toHaveLength(0);

    await t.reopen();
    await until(async () => (await t.cell.waiting()).length === 1);
    expect(requestsOf(t.gateway, "research")).toHaveLength(0);

    await t.cell.setLimit(5, "owner");
    await until(async () => (await leadTexts(t)).some((text) => text.startsWith("Research says")));
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(requestsOf(t.gateway, "research")).toHaveLength(1);
    expect(await t.cell.waiting()).toEqual([]);
  }, 30_000);

  it("holds a reminder and a routine run, lists both, and runs each once after a raise", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let gate: BudgetWaiter | undefined;
    const fired: number[] = [];
    const morning = defineRoutine(
      {
        name: "morning-check",
        every: 3_600_000,
        run: async () => {
          fired.push(Date.now());
          return { outcome: "ok" };
        },
      },
      { cell: "owner", gate: () => gate },
    );
    const responder = (request: FauxRequest) => {
      if (request.role !== "lead") return fauxAssistantMessage([fauxText("n/a")]);
      if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("Set.")]);
      if (request.lastText.startsWith("[reminder]")) {
        return fauxAssistantMessage([fauxText(`Reminder: ${request.lastText.slice(11)}`)]);
      }
      if (request.lastText.includes("remind me")) {
        const at = new Date(Date.now() + 800).toISOString();
        return fauxAssistantMessage([fauxToolCall("set_reminder", { at, text: "bins out" })], {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage([fauxText("Hello.")]);
    };
    test = await openTestCell({
      gateway: createFauxGateway(responder),
      routines: [{ routine: morning, firstWakeMs: 1_500 }],
    });
    const t = test;
    gate = t.cell.budget.gate;
    await t.cell.setLimit(1, "owner");
    await addSpend(t.cell, 1.2);
    await (await t.cell.submit("please remind me about the bins", "rem-1")).wait(
      BACKGROUND_CONTEXT,
    );
    await until(async () => (await t.cell.waiting()).length === 2);
    expect((await t.cell.waiting()).map((item) => item.what).sort()).toEqual([
      "reminder bins out",
      "routine morning check",
    ]);
    const reminders = () =>
      t.gateway.requests.filter((request) => request.lastText.startsWith("[reminder]"));
    expect(reminders()).toHaveLength(0);
    expect(fired).toHaveLength(0);
    // Chat with the lead is still answered.
    await (await t.cell.submit("hello", "rem-2")).wait(BACKGROUND_CONTEXT);
    expect(reminders()).toHaveLength(0);

    await t.cell.setLimit(5, "owner");
    await until(() => fired.length === 1 && reminders().length === 1);
    await until(async () => (await t.cell.waiting()).length === 0);
    expect(fired).toHaveLength(1);
    expect(reminders()).toHaveLength(1);
  }, 30_000);

  it("lets a specialist's running job finish its step, then waits before its next request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder = async (request: FauxRequest) => {
      if (request.role === "research") {
        if (request.last?.role === "toolResult") {
          return fauxAssistantMessage([fauxText("research finding: evidence is mixed.")]);
        }
        await released;
        return fauxAssistantMessage([fauxToolCall("search_history", { query: "fasting" })], {
          stopReason: "toolUse",
        });
      }
      return handoffResponder(request);
    };
    test = await openTestCell({ gateway: createFauxGateway(responder) });
    const t = test;
    await t.cell.setLimit(1, "owner");
    await (await t.cell.submit("Find out about fasting for me", "job-1")).wait(BACKGROUND_CONTEXT);
    await until(() => requestsOf(t.gateway, "research").length === 1);
    // The person goes over the limit while the specialist's first request runs.
    await addSpend(t.cell, 1.2);
    release();
    await until(async () => (await t.cell.waiting()).some((item) => item.what === "job research"));
    const activity = await t.cell.activity();
    expect(
      activity.records.some((item) => item.agent === "research" && item.tool === "search_history"),
    ).toBe(true);
    expect(requestsOf(t.gateway, "research")).toHaveLength(1);

    await t.cell.setLimit(5, "owner");
    await until(async () => (await leadTexts(t)).some((text) => text.startsWith("Research says")));
    const research = requestsOf(t.gateway, "research");
    expect(research).toHaveLength(2);
    expect(research[1]?.last?.role).toBe("toolResult");
  }, 30_000);

  it("continues waiting work when the month resets at local midnight on the first", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 9, 31, 23, 0);
    const timers = new Set<() => void>();
    const budgetTimer: SetTimer = (_ms, fire) => {
      timers.add(fire);
      return () => timers.delete(fire);
    };
    test = await openTestCell({
      gateway: createFauxGateway(handoffResponder),
      env: { SECBOT_TIME_ZONE: "Europe/London" },
      now: () => clock,
      guard: { budgetTimer },
    });
    const t = test;
    await t.cell.setLimit(1, "owner");
    await addSpend(t.cell, 2);
    await (await t.cell.submit("Find out about fasting for me", "reset-1")).wait(
      BACKGROUND_CONTEXT,
    );
    await until(async () => (await t.cell.waiting()).length === 1);
    expect(requestsOf(t.gateway, "research")).toHaveLength(0);
    // Still October in London: a timer that fires early changes nothing.
    for (const fire of [...timers]) fire();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requestsOf(t.gateway, "research")).toHaveLength(0);

    clock = Date.UTC(2026, 10, 1, 0, 1);
    for (const fire of [...timers]) fire();
    await until(async () => (await leadTexts(t)).some((text) => text.startsWith("Research says")));
    expect((await t.cell.budgetState()).person.spentUsd).toBe(0);
    expect(requestsOf(t.gateway, "research")).toHaveLength(1);
    expect(await t.cell.waiting()).toEqual([]);
  }, 30_000);
});

describe("a 402 or 403 to a guard call", () => {
  it("enters the credit pause for the decision model and the reviewer, and the cell keeps answering", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = await startStubOpenRouter();
    try {
      let reviewer: () => string | AssistantMessage = () => verdictJson("allow", "ordinary");
      const lead = (request: FauxRequest) => {
        if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("done")]);
        if (request.lastText.startsWith("CALL ")) {
          return fauxAssistantMessage([fauxToolCall("search_history", { query: "kale" })], {
            stopReason: "toolUse",
          });
        }
        return fauxAssistantMessage([fauxText("ok")]);
      };
      const { incidents, fetcher } = incidentStub();
      test = await openTestCell({
        gateway: createFauxGateway(reviewerResponder(() => reviewer(), lead)),
        env: ALERT_ENV,
        fetch: fetcher,
        guard: {
          decision: createDecisionModels({ apiKey: KEY, baseUrl: stub.origin, timeoutMs: 1_000 }),
          reviewerTimeoutMs: 2_000,
        },
      });
      const t = test;
      const health = () =>
        loggedEvents(log.mock.calls)
          .filter((line) => line.event === "model.health")
          .map((line) => line.state);
      const credits = () => health().filter((state) => state === "credit").length;
      const answered = async (id: string) =>
        (await (await t.cell.submit("hello", id)).wait(BACKGROUND_CONTEXT)).status;

      for (const [index, status] of ([402, 403] as const).entries()) {
        stub.mode = status;
        const before = credits();
        await (await t.cell.submit("CALL search", `credit-decision-${status}`)).wait(
          BACKGROUND_CONTEXT,
        );
        await t.cell.monitor.settled();
        expect(credits()).toBe(before + 1);
        expect(incidents.length).toBeGreaterThanOrEqual(index + 1);
        expect(await answered(`after-decision-${status}`)).toBe("done");
        await t.cell.monitor.settled();
      }
      expect(incidents[0]?.body.summary).toBe("Secbot owner cell: model credit limit reached");

      // The decision model marks the call; the reviewer's answer is a 402.
      stub.mode = "answer";
      stub.decision = riskyAt(0.95);
      reviewer = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: CREDIT_402 });
      const before = credits();
      await (await t.cell.submit("CALL search", "credit-reviewer")).wait(BACKGROUND_CONTEXT);
      await t.cell.monitor.settled();
      expect(credits()).toBe(before + 1);
      expect(await answered("after-reviewer")).toBe("done");
      // The guard's outcome is its own: in shadow mode an unavailable reviewer is recorded as
      // "would ask", and the call ran.
      const activity = await t.cell.activity();
      expect(
        activity.records.some((item) => item.layer === "reviewer" && item.verdict === "would ask"),
      ).toBe(true);
    } finally {
      await test?.cell.close();
      test = undefined;
      await stub.close();
    }
  }, 30_000);
});
