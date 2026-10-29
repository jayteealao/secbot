/**
 * `secbot chat`: a session with the lead. Each line goes to the lead unchanged with a fresh
 * request id; the lead's answer streams in; a follow-up that arrives while the session is open is
 * printed with no new command. After a dropped connection the CLI reconnects and resends every
 * line the cell has not acknowledged, under the same request id, so nothing is submitted twice.
 * Calls held for the person arrive first, as `held` frames, then messages the lead sent while no
 * session was open, as `missed` frames. Only an exact `/allow N`, `/always N`, or `/deny N`
 * answers a held call, and only an exact `/answer <#> <text>` answers a job's question the lead
 * put to the person (printed after the lead's words as `[ job <n> asks ]`); every other line goes
 * to the lead unchanged. The usage line (the month's
 * spend against the person's limit) prints on connect and after each answer; a limit notice prints
 * when a limit line is reached, or at connect when this device has not seen it.
 */
import { randomUUID } from "node:crypto";
import type { CellClient } from "../client.ts";
import type { Io } from "../io.ts";
import { answerHeld, answerOf, type HeldCall, heldBlock, NOT_SENT } from "./held.ts";
import { ANSWER_NOT_SENT, answerJob, answerJobOf, questionLine } from "./job-answer.ts";
import { answerShared, SHARED_NOT_SENT, sharedLine, sharedOf } from "./shared-confirm.ts";
import { type Notice, noticeBlock, type Usage, usageLine, type Waiting } from "./usage.ts";

export type Frame =
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
  | { type: "notice"; notice: Notice; waiting: Waiting[] }
  | { type: "question"; job: number; title: string }
  | { type: "shared"; job: number; title: string; from: string; payer: "half" | "all" };

/** The widest line a missed message prints at; longer ones continue indented by two spaces. */
const MISSED_WIDTH = 79;

/**
 * `prefix` and one line of `said` as it fits in MISSED_WIDTH columns, the rest on lines indented
 * by two spaces. A line that fits, or one with line breaks of its own, prints unchanged. Display
 * only: the result goes to stdout and routes nothing.
 */
export function wrapped(prefix: string, said: string): string {
  const whole = prefix + said;
  if (whole.length <= MISSED_WIDTH || whole.split("\n").length > 1) return whole;
  const lines: string[] = [];
  let line = prefix;
  // No word on the line yet: the next one goes on it whatever its length.
  let empty = true;
  for (const word of said.split(" ").filter((each) => each !== "")) {
    const next = empty ? line + word : `${line} ${word}`;
    if (empty || next.length <= MISSED_WIDTH) {
      line = next;
    } else {
      lines.push(line);
      line = `  ${word}`;
    }
    empty = false;
  }
  lines.push(line);
  return lines.join("\n");
}

/** The longest line the cell accepts, in characters. */
export const INPUT_LIMIT = 20_000;

export interface ChatOptions {
  /** Milliseconds before a reconnect; doubles up to 30 s. */
  readonly reconnectMs?: number;
}

/**
 * Prints the cell's session frames as `secbot chat` shows them: the held-call block once per call,
 * the usage line, each limit notice once, the lead's answer as it streams, and follow-ups. Shared
 * with the stand-in rehearsal of the live guard check, so both print the same lines. `settled` is
 * told each request id the cell accepted or refused.
 */
export function frameRenderer(
  io: Io,
  settled: (requestId: string) => void = () => {},
): { handle: (frame: Frame) => void; print: (text: string) => void } {
  let midAnswer = false;
  let noted = false;
  const shown = new Set<number>();
  const noticed = new Set<number>();
  const asked = new Set<number>();
  const offered = new Set<number>();

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
        settled(frame.requestId);
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
        print(`${wrapped(frame.from === null ? "lead: " : `[from ${frame.from}] `, frame.text)}\n`);
        if (frame.remaining > 0 && !noted) {
          noted = true;
          print(`${frame.remaining} more missed message(s); run "secbot missed"\n`);
        }
        break;
      case "rejected":
        // The cell refused this line; resending it would be refused the same way.
        settled(frame.requestId);
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
      case "question":
        // Once per job in this session, one blank line after the lead's words.
        if (asked.has(frame.job)) break;
        asked.add(frame.job);
        print(`\n${questionLine(frame.job)}\n`);
        break;
      case "shared":
        // Once per job in this session, one blank line after the lead's words.
        if (offered.has(frame.job)) break;
        offered.add(frame.job);
        print(`\n${sharedLine(frame.job, frame.from, frame.payer)}\n`);
        break;
    }
  };

  return { handle, print };
}

export async function chat(client: CellClient, io: Io, options: ChatOptions = {}): Promise<number> {
  // Fails fast, with the cell's reason, when the device is refused.
  await client.request("GET", "/status");
  const pending = new Map<string, string>();
  let socket: WebSocket | undefined;
  let open = false;
  let closing = false;
  let delay = options.reconnectMs ?? 1_000;
  let ready!: () => void;
  let connected = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const { handle, print } = frameRenderer(io, (requestId) => pending.delete(requestId));

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
    // An answer to a job's question goes to the cell's answer route, never to the lead; a line
    // that only looks like one is not sent at all.
    // A join or decline of a shared job goes to the cell's routes, never to the lead; a line that
    // only looks like one is not sent at all.
    const shared = sharedOf(text);
    if (shared.kind === "join" || shared.kind === "decline") {
      print("");
      await answerShared(client, io, shared.job, shared.kind === "join");
      continue;
    }
    if (shared.kind === "malformed") {
      io.stderr(`${SHARED_NOT_SENT}\n`);
      continue;
    }
    const job = answerJobOf(text);
    if (job.kind === "answer") {
      print("");
      await answerJob(client, io, job.job, job.text);
      continue;
    }
    if (job.kind === "malformed") {
      io.stderr(`${ANSWER_NOT_SENT}\n`);
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
