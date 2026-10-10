/**
 * A local HTTP stand-in for OpenRouter: the Anthropic messages route (`/api/v1/messages`), the
 * chat completions route (`/api/v1/chat/completions`), and the Decisions API
 * (`/api/alpha/decisions`, TypeSafe's System One body). It answers with a short streamed reply (a
 * scripted decision on the decisions route), or with a scripted HTTP failure, a malformed body, an
 * unknown choice, or never answers (a timeout). Reached through the gateway's OPENROUTER_BASE_URL,
 * which replaces the https://openrouter.ai origin.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The HTTP failures the Decisions API documents, plus the ones the chat routes already used. */
export const STUB_STATUSES = [400, 401, 402, 403, 413, 429, 500, 502, 503, 524, 529] as const;

export type StubMode =
  | "answer"
  | (typeof STUB_STATUSES)[number]
  | "malformed"
  | "unknown-choice"
  | "hang";

/** What the decisions route answers in `answer` mode. */
export interface StubDecision {
  readonly choice: string;
  readonly probabilities: Record<string, number>;
}

export const DECISIONS_ROUTE = "/api/alpha/decisions";

export interface SeenRequest {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

const ERROR_TEXT: Record<number, string> = {
  400: "Bad request",
  401: "No auth credentials found",
  402: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
  403: "Forbidden",
  413: "Request too large",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway",
  503: "No available provider",
  524: "Timeout",
  529: "Overloaded",
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

/** The decisions route's answer: the dated model id, one choice answer, and usage. */
function decisionAnswer(model: unknown, decision: StubDecision, choice = decision.choice): string {
  return JSON.stringify({
    model: `${String(model)}-20261001`,
    answers: {
      risk: {
        type: "choice",
        choice,
        probabilities: decision.probabilities,
        confidence: Math.max(...Object.values(decision.probabilities)),
      },
    },
    usage: { input_tokens: 400, output_tokens: 0 },
  });
}

/** A body cut off in the middle, as from a broken proxy. */
const MALFORMED = '{"model": "cut off", "answers": {"risk": {"type": "cho';

export interface StubOpenRouter {
  readonly origin: string;
  readonly seen: SeenRequest[];
  mode: StubMode;
  /** The decisions route's answer in `answer` mode (routine, score 0.05 by default). */
  decision: StubDecision;
  /** When set, the decisions route's answer for each request body, in place of `decision`. */
  decide: ((body: Record<string, unknown>) => StubDecision) | undefined;
  /** A delay before every answer, in milliseconds (0 by default). */
  delayMs: number;
  close(): Promise<void>;
}

/** A routine answer: probabilities that sum to 1, with risky plus unclear at `score`. */
export function routineAt(score: number): StubDecision {
  return {
    choice: "routine",
    probabilities: { routine: 1 - score, risky: score / 2, unclear: score / 2 },
  };
}

/** A risky answer with risky plus unclear at `score`. */
export function riskyAt(score: number): StubDecision {
  return {
    choice: "risky",
    probabilities: { routine: 1 - score, risky: score * 0.8, unclear: score * 0.2 },
  };
}

export async function startStubOpenRouter(): Promise<StubOpenRouter> {
  const seen: SeenRequest[] = [];
  const hanging = new Set<() => void>();
  const stub = {
    mode: "answer" as StubMode,
    decision: routineAt(0.05),
    decide: undefined as ((body: Record<string, unknown>) => StubDecision) | undefined,
    delayMs: 0,
  };
  const answer = (path: string, body: Record<string, unknown>, response: ServerResponse) => {
    if (stub.mode === "hang") {
      hanging.add(() => response.destroy());
      return;
    }
    if (typeof stub.mode === "number") {
      response.writeHead(stub.mode, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: stub.mode, message: ERROR_TEXT[stub.mode] } }));
      return;
    }
    if (path === DECISIONS_ROUTE) {
      response.writeHead(200, { "content-type": "application/json" });
      if (stub.mode === "malformed") {
        response.end(MALFORMED);
        return;
      }
      const choice = stub.mode === "unknown-choice" ? "maybe" : undefined;
      response.end(decisionAnswer(body.model, stub.decide?.(body) ?? stub.decision, choice));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      path.endsWith("/messages")
        ? anthropicAnswer("Stub answer.")
        : completionsAnswer("Stub answer."),
    );
  };
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push({ path, headers: request.headers, body });
      if (stub.delayMs > 0 && stub.mode !== "hang") {
        setTimeout(() => answer(path, body, response), stub.delayMs);
        return;
      }
      answer(path, body, response);
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
    get decision() {
      return stub.decision;
    },
    set decision(decision: StubDecision) {
      stub.decision = decision;
    },
    get decide() {
      return stub.decide;
    },
    set decide(decide: ((body: Record<string, unknown>) => StubDecision) | undefined) {
      stub.decide = decide;
    },
    get delayMs() {
      return stub.delayMs;
    },
    set delayMs(ms: number) {
      stub.delayMs = ms;
    },
    async close() {
      for (const end of hanging) end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
