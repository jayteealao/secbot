/**
 * `secbot chat`: a session with the lead. Each line goes to the lead unchanged with a fresh
 * request id; the lead's answer streams in; a follow-up that arrives while the session is open is
 * printed with no new command. After a dropped connection the CLI reconnects and resends every
 * line the cell has not acknowledged, under the same request id, so nothing is submitted twice.
 * Calls held for the person arrive first, as `held` frames, then messages the lead sent while no
 * session was open, as `missed` frames. Only an exact `/allow N`, `/always N`, or `/deny N`
 * answers a held call; every other line goes to the lead unchanged. The usage line (the month's
 * spend against the person's limit) prints on connect and after each answer; a limit notice prints
 * when a limit line is reached, or at connect when this device has not seen it.
 */
import { randomUUID } from "node:crypto";
import type { CellClient } from "../client.ts";
import type { Io } from "../io.ts";
import { answerHeld, answerOf, type HeldCall, heldBlock, NOT_SENT } from "./held.ts";
import { type Notice, noticeBlock, type Usage, usageLine, type Waiting } from "./usage.ts";

type Frame =
  | { type: "connected"; lead: string }
  | { type: "accepted"; requestId: string }
  | { type: "delta"; text: string }
  | { type: "answer"; entryId: number; text: string }
  | { type: "followup"; entryId: number; from: string; text: string }
  | { type: "waiting"; on: boolean }
  | { type: "missed"; entryId: number; from: string | null; text: string; remaining: number }
  | { type: "rejected"; requestId: string; message: string }
  | { type: "error"; message: string; requestId?: string }
  | { type: "held"; call: HeldCall; count: number }
  | { type: "usage"; usage: Usage }
  | { type: "notice"; notice: Notice; waiting: Waiting[] };

/** The longest line the cell accepts, in characters. */
export const INPUT_LIMIT = 20_000;

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
  let noted = false;
  const shown = new Set<number>();
  const noticed = new Set<number>();
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
      case "missed":
        print(
          frame.from === null ? `lead: ${frame.text}\n` : `[from ${frame.from}] ${frame.text}\n`,
        );
        if (frame.remaining > 0 && !noted) {
          noted = true;
          print(`${frame.remaining} more missed message(s); run "secbot missed"\n`);
        }
        break;
      case "rejected":
        // The cell refused this line; resending it would be refused the same way.
        pending.delete(frame.requestId);
        io.stderr(`cell refused a message: ${frame.message}\n`);
        break;
      case "error":
        io.stderr(`cell: ${frame.message}\n`);
        break;
      case "held":
        // Once per call in this session: a reconnect sends every waiting call again.
        if (shown.has(frame.call.number)) break;
        shown.add(frame.call.number);
        print(`\n${heldBlock(frame.call, frame.count).join("\n")}\n`);
        break;
      case "usage":
        print(`${usageLine(frame.usage)}\n`);
        break;
      case "notice":
        // Once per notice in this session, one blank line before it.
        if (noticed.has(frame.notice.seq)) break;
        noticed.add(frame.notice.seq);
        print(`\n${noticeBlock(frame.notice, frame.waiting ?? []).join("\n")}\n`);
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
      // Wake anyone still awaiting the promise being replaced; they re-check `open` and then wait
      // on the new one. Without this, an early close strands the startup wait on a dead promise.
      ready();
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
  // A close before the first open replaces `connected`, so wait on the current one until open.
  while (!open) await connected;
  for await (const line of io.lines()) {
    const text = line.trim();
    if (text === "") continue;
    if (text.length > INPUT_LIMIT) {
      io.stderr(`not sent: a message is at most ${INPUT_LIMIT} characters\n`);
      continue;
    }
    // An answer to a held call goes to the cell's approval route, never to the lead; a line that
    // only looks like one is not sent at all.
    const kind = answerOf(text);
    if (kind.kind === "answer") {
      print("");
      await answerHeld(client, io, kind.choice, kind.number);
      continue;
    }
    if (kind.kind === "malformed") {
      io.stderr(`${NOT_SENT}\n`);
      continue;
    }
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
