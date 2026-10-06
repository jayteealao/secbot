/**
 * `secbot chat`: a session with the lead. Each line goes to the lead unchanged with a fresh
 * request id; the lead's answer streams in; a follow-up that arrives while the session is open is
 * printed with no new command. After a dropped connection the CLI reconnects and resends every
 * line the cell has not acknowledged, under the same request id, so nothing is submitted twice.
 */
import { randomUUID } from "node:crypto";
import type { CellClient } from "../client.ts";
import type { Io } from "../io.ts";

type Frame =
  | { type: "connected"; lead: string }
  | { type: "accepted"; requestId: string }
  | { type: "delta"; text: string }
  | { type: "answer"; entryId: number; text: string }
  | { type: "followup"; entryId: number; from: string; text: string }
  | { type: "waiting"; on: boolean }
  | { type: "error"; message: string };

export interface ChatOptions {
  /** Milliseconds before a reconnect; doubles up to 30 s. */
  readonly reconnectMs?: number;
}

export async function chat(client: CellClient, io: Io, options: ChatOptions = {}): Promise<number> {
  // Fails fast, with the cell's reason, when the device is refused.
  await client.request("GET", "/status");
  const pending = new Map<string, string>();
  let socket: WebSocket | undefined;
  let open = false;
  let closing = false;
  let midAnswer = false;
  let delay = options.reconnectMs ?? 1_000;
  let ready!: () => void;
  let connected = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const print = (text: string) => {
    if (midAnswer) io.stdout("\n");
    midAnswer = false;
    io.stdout(text);
  };

  const handle = (frame: Frame) => {
    switch (frame.type) {
      case "connected":
        print(`connected to ${frame.lead} lead\n`);
        break;
      case "accepted":
        pending.delete(frame.requestId);
        break;
      case "delta":
        io.stdout(frame.text);
        midAnswer = true;
        break;
      case "answer":
        if (midAnswer) io.stdout("\n");
        midAnswer = false;
        break;
      case "followup":
        print(`[from ${frame.from}] ${frame.text}\n`);
        break;
      case "waiting":
        print(frame.on ? "waiting for the model\n" : "the model is answering again\n");
        break;
      case "error":
        io.stderr(`cell: ${frame.message}\n`);
        break;
    }
  };

  const send = (requestId: string, text: string) => {
    if (open) socket?.send(JSON.stringify({ type: "input", text, requestId }));
  };

  const connect = () => {
    const current = client.openSocket();
    socket = current;
    current.addEventListener("open", () => {
      open = true;
      delay = options.reconnectMs ?? 1_000;
      for (const [requestId, text] of pending) send(requestId, text);
      ready();
    });
    current.addEventListener("message", (event) => {
      try {
        handle(JSON.parse(String(event.data)) as Frame);
      } catch {
        io.stderr("cell: an unreadable frame\n");
      }
    });
    current.addEventListener("close", () => {
      open = false;
      if (closing) return;
      print(`connection lost; reconnecting in ${Math.round(delay / 1000)} s\n`);
      connected = new Promise<void>((resolve) => {
        ready = resolve;
      });
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    current.addEventListener("error", () => {
      // The close event follows and reconnects.
    });
  };

  connect();
  await connected;
  for await (const line of io.lines()) {
    const text = line.trim();
    if (text === "") continue;
    const requestId = `cli-${randomUUID()}`;
    pending.set(requestId, text);
    await connected;
    send(requestId, text);
  }
  // End of input: wait (up to 10 s) for the cell to acknowledge what was sent.
  const deadline = Date.now() + 10_000;
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  closing = true;
  socket?.close(1000, "bye");
  if (pending.size > 0) {
    io.stderr(`${pending.size} message(s) were not acknowledged; run "secbot missed" later\n`);
    return 1;
  }
  return 0;
}
