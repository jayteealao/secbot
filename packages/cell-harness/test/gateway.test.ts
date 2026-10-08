// The model gateway over the wire, against a local OpenRouter stub: one key from the cell var,
// prompt caching on the lead's Anthropic requests, failures that stay retryable, a 402
// turned into a retryable credit pause, and the release ids resolvable.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CREDIT_PAUSE_TEXT } from "../src/credit-pause.ts";
import { createGatewayModels } from "../src/gateway.ts";
import { openCellHarness } from "../src/open-harness.ts";
import { DEFAULT_LEAD_MODEL, DEFAULT_SPECIALIST_MODEL } from "../src/release-defaults.ts";
import { FakeCelldStorage } from "./fixtures.ts";
import { type StubOpenRouter, startStubOpenRouter } from "./stub-openrouter.ts";

const KEY = "sk-or-test-not-a-real-key";
const COMPLETIONS_MODEL = "google/gemini-3.5-flash";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(async () => {
  await stub.close();
});

async function call(
  modelId: string,
  options: Record<string, unknown> = {},
): Promise<AssistantMessage> {
  const models = createGatewayModels({ OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: stub.origin });
  const model = models.getModel("openrouter", modelId);
  if (model === undefined) throw new Error(`no model ${modelId}`);
  return models
    .streamSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      {
        maxRetries: 0,
        ...options,
      },
    )
    .result();
}

describe("the OpenRouter gateway", () => {
  it("resolves the release's default ids from the installed catalog and nothing unknown", () => {
    const models = createGatewayModels({});
    expect(models.getModel("openrouter", DEFAULT_LEAD_MODEL)?.api).toBe("anthropic-messages");
    expect(models.getModel("openrouter", DEFAULT_SPECIALIST_MODEL)?.api).toBe("anthropic-messages");
    expect(models.getModel("openrouter", "openai/not-a-model")).toBeUndefined();
  });

  it("sends the cell's key and asks for prompt caching on the lead's model", async () => {
    stub.mode = "answer";
    const answer = await call(DEFAULT_LEAD_MODEL);
    expect(answer.stopReason).toBe("stop");
    expect(answer.content).toEqual([
      expect.objectContaining({ type: "text", text: "Stub answer." }),
    ]);
    const request = stub.seen.at(-1);
    expect(request?.path).toBe("/api/v1/messages");
    expect(request?.headers["x-api-key"] ?? request?.headers.authorization).toContain(KEY);
    expect(JSON.stringify(request?.body)).toContain("cache_control");
  });

  it("answers on a chat-completions model too", async () => {
    stub.mode = "answer";
    const answer = await call(COMPLETIONS_MODEL);
    expect(answer.stopReason).toBe("stop");
    expect(stub.seen.at(-1)?.path).toBe("/api/v1/chat/completions");
    expect(stub.seen.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([429, 500, 503] as const)(
    "keeps HTTP %i retryable and not a credit pause",
    async (status) => {
      stub.mode = status;
      for (const id of [DEFAULT_LEAD_MODEL, COMPLETIONS_MODEL]) {
        const failed = await call(id);
        expect(failed.stopReason).toBe("error");
        expect(isRetryableAssistantError(failed)).toBe(true);
        expect(failed.errorMessage).not.toContain(CREDIT_PAUSE_TEXT);
      }
    },
  );

  it("turns HTTP 402 into a retryable credit pause on both APIs", async () => {
    stub.mode = 402;
    for (const id of [DEFAULT_LEAD_MODEL, COMPLETIONS_MODEL]) {
      const paused = await call(id);
      expect(paused.errorMessage).toBe(CREDIT_PAUSE_TEXT);
      expect(isRetryableAssistantError(paused)).toBe(true);
    }
  });

  it("keeps a request that times out retryable", async () => {
    stub.mode = "hang";
    const failed = await call(COMPLETIONS_MODEL, { timeoutMs: 300 });
    expect(failed.stopReason).toBe("error");
    expect(isRetryableAssistantError(failed)).toBe(true);
  });

  it("answers a lead turn end to end through the cell's own gateway", async () => {
    stub.mode = "answer";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cell = await openCellHarness(new FakeCelldStorage(), {
      person: "owner",
      version: "v0.0.0-test",
      env: { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: stub.origin },
    });
    try {
      const settled = await (await cell.submit("hello", "wire-1")).wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");
      const missed = (await cell.missed("laptop")).messages;
      expect(missed.map((message) => message.text)).toEqual(["Stub answer."]);
    } finally {
      await cell.close();
      vi.restoreAllMocks();
    }
  });
});
