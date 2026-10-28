// The decision model against the stub Decisions API: both adapters, the returned dated model id
// and the cost, every documented failure as a DecisionFailure with no retry, the state builder's
// cap and redaction, and the per-tool thresholds against the example corpus.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDecisionState,
  createDecisionModel,
  DecisionFailure,
  markScore,
  parseThresholdCaps,
  RISK_QUESTION,
  thresholdFor,
  UNTRUSTED_NOTE,
} from "../src/decision-model.ts";
import { DECISION_STATE_LIMIT } from "../src/release-defaults.ts";
import { DECISION_EXAMPLES } from "./decision-examples.ts";
import {
  cleanAt,
  DECISIONS_ROUTE,
  injectionAt,
  riskyAt,
  routineAt,
  STUB_STATUSES,
  type StubMode,
  type StubOpenRouter,
  startStubOpenRouter,
} from "./stub-openrouter.ts";

const KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)

let stub: StubOpenRouter;
beforeEach(async () => {
  stub = await startStubOpenRouter();
});
afterEach(async () => {
  await stub.close();
});

const state = {
  tool: "start_job",
  agent: "lead",
  rule: "none",
  note: UNTRUSTED_NOTE,
  arguments: {},
};

describe("the Decisions API client", () => {
  it.each([
    ["clef", "cloudflare/clef"],
    ["jev", "typesafe/jev-1.13"],
  ] as const)(
    "the %s adapter posts its model id to the decisions path with the key",
    async (adapter, id) => {
      const model = createDecisionModel(adapter, { apiKey: KEY, baseUrl: stub.origin });
      const answer = await model.ask(state, "start_job");
      expect(stub.seen).toHaveLength(1);
      const [request] = stub.seen;
      expect(request?.path).toBe(DECISIONS_ROUTE);
      expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request?.body).toMatchObject({ model: id, state, questions: { risk: RISK_QUESTION } });
      expect(answer).toMatchObject({
        outcome: "pass",
        choice: "routine",
        model: `${id}-20261001`,
      });
      expect(answer.score).toBeCloseTo(0.05);
      // 400 input tokens at the catalogue price: a small cost, never zero.
      expect(answer.costUsd).toBeGreaterThan(0);
    },
  );

  it("marks a call at or above the tool's threshold", async () => {
    stub.decision = riskyAt(0.5);
    const model = createDecisionModel("clef", { apiKey: KEY, baseUrl: stub.origin });
    expect((await model.ask(state, "start_job")).outcome).toBe("mark");
    stub.decision = riskyAt(0.49);
    expect((await model.ask(state, "start_job")).outcome).toBe("pass");
  });

  const failures: [StubMode, string][] = [
    ...STUB_STATUSES.map((status): [StubMode, string] => [status, `http-${status}`]),
    ["malformed", "malformed"],
    ["unknown-choice", "unknown-choice"],
    ["hang", "timeout"],
  ];

  it.each(failures)(
    "stub mode %s is a DecisionFailure (%s) after one request",
    async (mode, cause) => {
      stub.mode = mode;
      const model = createDecisionModel("clef", {
        apiKey: KEY,
        baseUrl: stub.origin,
        timeoutMs: 300,
      });
      const failure = await model.ask(state, "start_job").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DecisionFailure);
      expect((failure as DecisionFailure).cause).toBe(cause);
      expect(stub.seen).toHaveLength(1);
    },
  );

  it("fails with no-key and sends nothing when the cell has no key", async () => {
    const model = createDecisionModel("clef", { apiKey: undefined, baseUrl: stub.origin });
    const failure = await model.ask(state, "start_job").catch((error: unknown) => error);
    expect((failure as DecisionFailure).cause).toBe("no-key");
    expect(stub.seen).toHaveLength(0);
  });
});

describe("the stub decisions route", () => {
  const post = async (questions: Record<string, unknown>) => {
    const response = await fetch(new URL(DECISIONS_ROUTE, stub.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "typesafe/jev-1.13", state: { content: "x" }, questions }),
    });
    return (await response.json()) as { answers: Record<string, { choice: string }> };
  };

  it("answers under the key of each asked question", async () => {
    stub.decision = injectionAt(0.9);
    const body = await post({ injection: { type: "choice" } });
    expect(Object.keys(body.answers)).toEqual(["injection"]);
    expect(body.answers.injection).toMatchObject({
      choice: "injection",
      probabilities: {
        clean: expect.closeTo(0.1),
        injection: expect.closeTo(0.72),
        unclear: expect.closeTo(0.18),
      },
    });
  });

  it("lets a test answer from the state's text", async () => {
    stub.decide = (body) =>
      JSON.stringify(body.state).includes("order") ? injectionAt(0.8) : cleanAt(0.1);
    expect((await post({ injection: { type: "choice" } })).answers.injection?.choice).toBe("clean");
    expect(cleanAt(0.1).probabilities).toEqual({
      clean: 0.9,
      injection: 0.05,
      unclear: 0.05,
    });
  });
});

describe("the threshold caps (test cell only)", () => {
  it("a cap of 0 marks a score of 0; a cap above the release value changes nothing", async () => {
    stub.decision = routineAt(0);
    const capped = createDecisionModel("clef", {
      apiKey: KEY,
      baseUrl: stub.origin,
      thresholdCaps: { set_reminder: 0 },
    });
    const reminder = await capped.ask(state, "set_reminder");
    expect(reminder.score).toBe(0);
    expect(reminder.outcome).toBe("mark");
    // Another tool keeps its release threshold.
    expect((await capped.ask(state, "start_job")).outcome).toBe("pass");
    stub.decision = riskyAt(0.6);
    const loose = createDecisionModel("clef", {
      apiKey: KEY,
      baseUrl: stub.origin,
      thresholdCaps: { set_reminder: 0.9 },
    });
    // The release threshold for set_reminder is 0.5: a cap of 0.9 never raises it.
    expect((await loose.ask(state, "set_reminder")).outcome).toBe("mark");
  });

  it("parses a JSON object of tool to 0..1 and ignores anything else", () => {
    expect(parseThresholdCaps('{"set_reminder":0,"start_job":0.25}')).toEqual({
      set_reminder: 0,
      start_job: 0.25,
    });
    expect(parseThresholdCaps('{"a":"x","b":-1,"c":2,"d":0.5}')).toEqual({ d: 0.5 });
    for (const bad of [undefined, "", "  ", "x", "{not json", "[0.1]", "null", "3"]) {
      expect(parseThresholdCaps(bad)).toEqual({});
    }
  });
});

describe("the decision state", () => {
  it("stays under the cap, keeps the tool name, the matched field, and the note, and redacts secrets", () => {
    const secret = "sk-test-0123456789abcdefghijklmnop"; // gitleaks:allow (fake test token)
    const built = buildDecisionState(
      {
        tool: "start_job",
        role: "lead",
        arguments: {
          template: "research",
          brief: "x".repeat(20_000),
          api_key: secret,
          note: `call me back, token ${secret}`,
        },
      },
      "your rule: lead start_job (template = research) -> permit",
      ["template"],
    );
    const text = JSON.stringify(built);
    expect(new TextEncoder().encode(text).length).toBeLessThan(DECISION_STATE_LIMIT);
    expect(built).toMatchObject({
      tool: "start_job",
      agent: "lead",
      note: UNTRUSTED_NOTE,
      arguments: { template: "research", api_key: "[redacted]", "…dropped": ["brief"] },
    });
    expect(text).not.toContain(secret);
  });
});

describe("the thresholds against the example corpus", () => {
  it.each(DECISION_EXAMPLES)("$name: $expected", async (example) => {
    expect(markScore(example.probabilities) >= thresholdFor(example.tool)).toBe(
      example.expected === "mark",
    );
    stub.decision = { choice: example.choice, probabilities: example.probabilities };
    const model = createDecisionModel("clef", { apiKey: KEY, baseUrl: stub.origin });
    const built = buildDecisionState(
      { tool: example.tool, role: "lead", arguments: example.arguments },
      "none",
      [],
    );
    expect((await model.ask(built, example.tool)).outcome).toBe(example.expected);
  });
});
