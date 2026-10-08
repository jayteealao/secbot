// Every model call logs the serving model, the token counts, and the cost.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREDIT_PAUSE_TEXT } from "../src/credit-pause.ts";
import { modelCallLine } from "../src/telemetry.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type TestCell,
} from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("model call log", () => {
  it("writes one model.call line per call with the served model, tokens, and cost", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = createFauxGateway(() => ({
      ...fauxAssistantMessage([fauxText("An answer with a few words in it.")]),
      responseModel: "anthropic/claude-opus-5.5-20260901",
    }));
    test = await openTestCell({ gateway });
    await (await test.cell.submit("Hello there", "t-1")).wait(BACKGROUND_CONTEXT);
    await (await test.cell.submit("Again", "t-2")).wait(BACKGROUND_CONTEXT);
    const calls = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === "model.call");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({
        cell: "owner",
        role: "lead",
        provider: "openrouter",
        model: "anthropic/claude-opus-5.5",
        served_model: "anthropic/claude-opus-5.5-20260901",
        stop_reason: "stop",
        credit: false,
      });
      expect(call.input_tokens).toBeGreaterThan(0);
      expect(call.output_tokens).toBeGreaterThan(0);
      // The faux provider reports no price; the field is always present for the cost estimate.
      expect(typeof call.cost_usd).toBe("number");
    }
    expect(JSON.stringify(calls)).not.toContain("Hello there");
  });

  it("copies the cost and cache tokens pi-ai computed, and flags a credit pause", () => {
    const message = {
      ...fauxAssistantMessage([fauxText("x")]),
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      usage: {
        input: 1200,
        output: 300,
        cacheRead: 1000,
        cacheWrite: 0,
        totalTokens: 2500,
        cost: { input: 0.0012, output: 0.0015, cacheRead: 0.0001, cacheWrite: 0, total: 0.0028 },
      },
    };
    expect(modelCallLine("owner", "research", ROOT_CONVERSATION_ID, message)).toMatchObject({
      role: "research",
      served_model: "anthropic/claude-haiku-4.5",
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 1000,
      cost_usd: 0.0028,
      credit: false,
    });
    const paused = { ...message, stopReason: "error" as const, errorMessage: CREDIT_PAUSE_TEXT };
    expect(modelCallLine("owner", "lead", ROOT_CONVERSATION_ID, paused).credit).toBe(true);
  });
});
