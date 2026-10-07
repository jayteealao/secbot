/**
 * A local HTTP stand-in for OpenRouter: the Anthropic messages route (`/api/v1/messages`) and the
 * chat completions route (`/api/v1/chat/completions`). It answers with a short streamed reply, or
 * with a scripted HTTP failure, or never answers (a timeout). Reached through the gateway's
 * OPENROUTER_BASE_URL, which replaces the https://openrouter.ai origin.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type StubMode = "answer" | 402 | 429 | 500 | 503 | "hang";

export interface SeenRequest {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

const ERROR_TEXT: Record<number, string> = {
  402: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
  429: "Rate limit exceeded",
  500: "Internal server error",
  503: "No available provider",
};

function sse(events: readonly [string | undefined, unknown][]): string {
  return events
    .map(
      ([event, data]) =>
        `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

function anthropicAnswer(text: string): string {
  return sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "anthropic/claude-opus-5.5-20260901",
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function completionsAnswer(text: string): string {
  const chunk = (delta: unknown, finish: string | null, usage?: unknown) => ({
    id: "gen-stub",
    object: "chat.completion.chunk",
    model: "google/gemini-3.5-flash-001",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  });
  return `${sse([
    [undefined, chunk({ role: "assistant", content: text }, null)],
    [undefined, chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })],
  ])}data: [DONE]\n\n`;
}

export interface StubOpenRouter {
  readonly origin: string;
  readonly seen: SeenRequest[];
  mode: StubMode;
  close(): Promise<void>;
}

export async function startStubOpenRouter(): Promise<StubOpenRouter> {
  const seen: SeenRequest[] = [];
  const hanging = new Set<() => void>();
  const stub = { mode: "answer" as StubMode };
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      seen.push({
        path,
        headers: request.headers,
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      });
      if (stub.mode === "hang") {
        hanging.add(() => response.destroy());
        return;
      }
      if (typeof stub.mode === "number") {
        response.writeHead(stub.mode, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: stub.mode, message: ERROR_TEXT[stub.mode] } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        path.endsWith("/messages")
          ? anthropicAnswer("Stub answer.")
          : completionsAnswer("Stub answer."),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    get mode() {
      return stub.mode;
    },
    set mode(mode: StubMode) {
      stub.mode = mode;
    },
    async close() {
      for (const end of hanging) end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
