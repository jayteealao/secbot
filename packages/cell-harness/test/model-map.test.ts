// A role's model changes with no release and the role's next request uses it; an id the
// gateway cannot resolve is refused and the map is unchanged.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusedChange } from "../src/cell-parts.ts";
import type { DecisionModels } from "../src/decision-model.ts";
import {
  ALTERNATE_MODEL,
  cleanContent,
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  isReviewerRequest,
  openTestCell,
  reviewerResponder,
  type TestCell,
  until,
  verdictJson,
} from "./fixtures.ts";
import { jobResponder, startJobLine } from "./responders.ts";

/** A decision model that marks every call for the reviewer. */
const markingDecision: DecisionModels = (adapter) => ({
  adapter,
  ask: async () => ({
    outcome: "mark",
    choice: "risky",
    score: 0.9,
    model: "stand-in",
    costUsd: 0,
    durationMs: 0,
  }),
  checkContent: cleanContent,
});

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe("role-to-model map", () => {
  it("starts from the release defaults", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const map = await test.cell.listRoleModels();
    expect(map[0]).toEqual({
      role: "lead",
      model: "anthropic/claude-opus-5.5",
      source: "release default",
    });
    // The three job tiers, with their per-job caps.
    expect(map.slice(1, 4)).toEqual([
      {
        role: "cheap",
        model: "anthropic/claude-haiku-4.5",
        source: "release default",
        capUsd: 0.25,
      },
      { role: "mid", model: "anthropic/claude-sonnet-5.5", source: "release default", capUsd: 1 },
      {
        role: "frontier",
        model: "anthropic/claude-opus-5.5",
        source: "release default",
        capUsd: 3,
      },
    ]);
    // The guard's reviewer comes last, with its own default.
    expect(map.at(-1)).toEqual({
      role: "reviewer",
      model: "anthropic/claude-sonnet-5.5",
      source: "release default",
    });
  });

  it("changes the reviewer's model; the next review uses it, and an unknown id is refused", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = createFauxGateway(
      reviewerResponder(
        () => verdictJson("allow", "an ordinary search"),
        (request) =>
          request.role === "lead" && request.last?.role !== "toolResult"
            ? fauxAssistantMessage([fauxToolCall("search_history", { query: "kale" })], {
                stopReason: "toolUse",
              })
            : fauxAssistantMessage([fauxText("done")]),
      ),
    );
    test = await openTestCell({ gateway, guard: { decision: markingDecision } });
    const t = test;
    await t.cell.setRoleModel("reviewer", "anthropic/claude-haiku-4.5");
    expect((await t.cell.listRoleModels()).at(-1)).toEqual({
      role: "reviewer",
      model: "anthropic/claude-haiku-4.5",
      source: "changed",
    });
    await (await t.cell.submit("search", "r1")).wait(BACKGROUND_CONTEXT);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const reviews = t.gateway.requests.filter(isReviewerRequest);
    expect(reviews.map((request) => request.modelId)).toEqual(["anthropic/claude-haiku-4.5"]);
    await expect(t.cell.setRoleModel("reviewer", "openai/not-a-model")).rejects.toThrow(
      RefusedChange,
    );
    expect((await t.cell.listRoleModels()).at(-1)?.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("refuses a specialist named reviewer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await expect(
      test.cell.addSpecialist({ name: "reviewer", instruction: "Review things." }),
    ).rejects.toThrow(/the reviewer is the guard's role/);
  });

  it("uses a changed model on the lead's next turn, and keeps it across a restart", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const t = test;
    await (await t.cell.submit("first", "a")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.modelId).toBe("anthropic/claude-opus-5.5");
    await t.cell.setRoleModel("lead", ALTERNATE_MODEL);
    await (await t.cell.submit("second", "b")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.modelId).toBe(ALTERNATE_MODEL);
    expect(lines(log).find((line) => line.event === "role_model.changed")).toMatchObject({
      role: "lead",
      from: "anthropic/claude-opus-5.5",
      to: ALTERNATE_MODEL,
      outcome: "changed",
    });
    await t.reopen();
    await (await t.cell.submit("third", "c")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.modelId).toBe(ALTERNATE_MODEL);
    expect((await t.cell.listRoleModels())[0]?.source).toBe("changed");
  });

  it("changes a tier's model for the next job on it, and keeps a running job's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    await t.cell.setRoleModel("mid", ALTERNATE_MODEL);
    expect((await t.cell.listRoleModels()).find((entry) => entry.role === "mid")).toEqual({
      role: "mid",
      model: ALTERNATE_MODEL,
      source: "changed",
      capUsd: 1,
    });
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: "look", template: "research" }), "j1")
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await t.cell.board()).jobs["1"]?.result != null);
    expect(t.gateway.requests.find((request) => request.role === "research")?.modelId).toBe(
      ALTERNATE_MODEL,
    );
  });

  it("changes a tier's cap for new jobs and refuses a bad cap or tier", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    expect(await t.cell.setTierCap("mid", 2.5)).toEqual({ tier: "mid", capUsd: 2.5 });
    expect((await t.cell.listRoleModels()).find((entry) => entry.role === "mid")?.capUsd).toBe(2.5);
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: "look", template: "research" }), "j1")
    ).wait(BACKGROUND_CONTEXT);
    expect((await t.cell.board()).jobs["1"]?.cap).toBe(2.5);
    await expect(t.cell.setTierCap("mid", 0)).rejects.toThrow(/a cap is a dollar amount/);
    await expect(t.cell.setTierCap("mid", 1.234)).rejects.toThrow(RefusedChange);
    await expect(t.cell.setTierCap("mid", 1_000_000)).rejects.toThrow(RefusedChange);
    await expect(t.cell.setTierCap("huge", 1)).rejects.toThrow(/unknown tier/);
    expect((await t.cell.listRoleModels()).find((entry) => entry.role === "mid")?.capUsd).toBe(2.5);
    expect(lines(log).filter((line) => line.event === "tier.cap_changed")).toEqual([
      expect.objectContaining({ tier: "mid", from_usd: 1, to_usd: 2.5, outcome: "changed" }),
      ...Array(4).fill(expect.objectContaining({ outcome: "refused" })),
    ]);
  });

  it("refuses an unresolvable id or an unknown role and leaves the map unchanged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const before = await test.cell.listRoleModels();
    await expect(test.cell.setRoleModel("lead", "openai/not-a-model")).rejects.toThrow(
      RefusedChange,
    );
    await expect(test.cell.setRoleModel("astrology", ALTERNATE_MODEL)).rejects.toThrow(
      /unknown role/,
    );
    expect(await test.cell.listRoleModels()).toEqual(before);
    expect(lines(log).filter((line) => line.event === "role_model.changed")).toEqual([
      expect.objectContaining({ outcome: "refused", to: "openai/not-a-model" }),
      expect.objectContaining({ outcome: "refused", role: "astrology" }),
    ]);
  });
});
