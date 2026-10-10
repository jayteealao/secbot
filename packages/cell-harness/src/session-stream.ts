/**
 * Frames for a chat session: the lead's answer as it streams, its end, relayed specialist
 * follow-ups, and the waiting-for-the-model state. Built from pi-durable's agent events for the
 * lead's root conversation (`watchEvents`, one batch per commit; a late joiner starts from the
 * current view and nothing is replayed: pi-durable README "Watching a Conversation"). This module
 * only reports what was committed; it never decides where a message goes.
 *
 * After each answer the stream sends a `usage` frame (month-to-date spend against the limit, and
 * the guard mode), and a `notice` frame when a limit line is reached.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, ROOT_CONVERSATION_ID, watchEvents } from "@earendil-works/pi-durable";
import { type HeldCallView, readHeld, viewOf } from "./approvals.ts";
import { leadMessageOf } from "./delivery.ts";
import { ApprovalsDoc, type LimitNotice, LimitNoticesDoc, ModelHealthDoc } from "./docs.ts";
import type { UsageLine, WaitingItem } from "./limits.ts";

export type Frame =
  | { readonly type: "connected"; readonly lead: string }
  | { readonly type: "accepted"; readonly requestId: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "answer"; readonly entryId: number; readonly text: string }
  | {
      readonly type: "followup";
      readonly entryId: number;
      readonly from: string;
      readonly text: string;
    }
  | { readonly type: "waiting"; readonly on: boolean }
  /**
   * A lead message that reached no open session for this device, sent when the session opens,
   * oldest first, before any live frame. `remaining` counts newer ones left for `missed`.
   */
  | {
      readonly type: "missed";
      readonly entryId: number;
      readonly from: string | null;
      readonly text: string;
      readonly remaining: number;
    }
  /** An input line the cell refused; the client stops resending it. */
  | { readonly type: "rejected"; readonly requestId: string; readonly message: string }
  | { readonly type: "error"; readonly message: string; readonly requestId?: string }
  /**
   * A call held for the person: sent once when it is held, and for every waiting call when a
   * session opens (before missed messages). `count` is how many calls wait in all.
   */
  | { readonly type: "held"; readonly call: HeldCallView; readonly count: number }
  /** Month-to-date spend against the limit and the mode: on connect and after each answer. */
  | { readonly type: "usage"; readonly usage: UsageLine }
  /**
   * A limit line reached (80% or 100% of the person's limit or the developer budget): sent once
   * when it is recorded, and for each notice the device has not seen when a session opens.
   */
  | {
      readonly type: "notice";
      readonly notice: LimitNotice;
      readonly waiting: readonly WaitingItem[];
    };

/** Every frame type, for checks that the documented protocol matches this union. */
export const FRAME_TYPES = [
  "connected",
  "accepted",
  "delta",
  "answer",
  "followup",
  "waiting",
  "missed",
  "rejected",
  "error",
  "held",
  "usage",
  "notice",
] as const satisfies readonly Frame["type"][];

export interface SessionStream {
  stop(): Promise<void>;
}

/** The cell's usage line and waiting list, for the `usage` and `notice` frames. */
export interface UsageSource {
  usage(): Promise<UsageLine>;
  waiting(): Promise<readonly WaitingItem[]>;
}

/**
 * Watches the lead and calls `send` with each frame. `delivered` runs after an answer or a
 * follow-up frame was sent, so the caller can advance delivery cursors.
 */
export async function openSessionStream(
  harness: Harness,
  send: (frame: Frame) => void,
  delivered: (entryId: number) => void | Promise<void> = () => {},
  now: () => number = Date.now,
  usage?: UsageSource,
): Promise<SessionStream> {
  const context = BACKGROUND_CONTEXT;
  const events = await watchEvents(harness, ROOT_CONVERSATION_ID, context);
  // The in-flight answer's text blocks by content index, and how much of it was already sent. A
  // block can arrive whole (`text_start`, `block`, `message`) or as appends (`text_delta`), and the
  // last part may only be in the committed entry, so deltas are computed from the full text.
  let blocks = new Map<number, string>();
  let sent = "";
  const flush = (full: string) => {
    if (full.length > sent.length && full.startsWith(sent)) {
      send({ type: "delta", text: full.slice(sent.length) });
      sent = full;
    }
  };
  const current = () =>
    [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join("");
  events.start(async (batch) => {
    for (const event of batch) {
      if (event.type === "message_start") {
        blocks = new Map();
        sent = "";
        // A partial that is already committed when the watch sees it starts with text.
        if (event.message.role === "assistant") {
          for (const [index, part] of event.message.content.entries()) {
            if (part.type === "text") blocks.set(index, part.text);
          }
          flush(current());
        }
      } else if (event.type === "message_update") {
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            blocks.set(change.contentIndex, (blocks.get(change.contentIndex) ?? "") + change.delta);
          } else if (
            (change.type === "text_start" || change.type === "block") &&
            change.block.type === "text"
          ) {
            blocks.set(change.contentIndex, change.block.text);
          } else if (change.type === "message") {
            blocks = new Map();
            for (const [index, part] of change.message.content.entries()) {
              if (part.type === "text") blocks.set(index, part.text);
            }
          }
        }
        flush(current());
      } else if (event.type === "message_end") {
        const final = event.entry.model?.[0];
        if (event.entry.kind === "pi.assistant" && final?.role === "assistant") {
          flush(
            final.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          );
        }
        blocks = new Map();
        sent = "";
        const message = leadMessageOf(event.entry);
        if (message === undefined) continue;
        if (message.kind === "answer") {
          send({ type: "answer", entryId: message.entryId, text: message.text });
          // The answer's own cost is in the same commit as its entry, so the line includes it.
          if (usage !== undefined) send({ type: "usage", usage: await usage.usage() });
        } else {
          send({
            type: "followup",
            entryId: message.entryId,
            from: message.from,
            text: message.text,
          });
        }
        await delivered(message.entryId);
      }
    }
  });
  const health = await harness.watchDoc(ModelHealthDoc, context);
  let waiting = health?.value?.waiting ?? false;
  if (waiting) send({ type: "waiting", on: true });
  health?.start(async (value) => {
    const next = value?.waiting ?? false;
    if (next !== waiting) {
      waiting = next;
      send({ type: "waiting", on: next });
    }
  });
  // Held calls: each newly held number is sent once per stream. Calls already waiting when the
  // stream starts are sent by each session as it opens.
  const approvals = await harness.watchDoc(ApprovalsDoc, context);
  const announced = new Set<number>(approvals?.value?.pending ?? []);
  const announce = async (pending: readonly number[]) => {
    for (const number of pending) {
      if (announced.has(number)) continue;
      announced.add(number);
      const call = await readHeld(harness, number, context);
      if (call?.status === "pending") {
        send({ type: "held", call: viewOf(call, now()), count: pending.length });
      }
    }
  };
  // The cell creates the document when it opens (open-harness.ts), so the watch exists.
  approvals?.start(async (value) => {
    await announce(value?.pending ?? []);
  });
  // Limit notices: each new one is sent once per stream; older ones go out when a session opens.
  const notices = await harness.watchDoc(LimitNoticesDoc, context);
  let noticed = (notices?.value?.next ?? 1) - 1;
  notices?.start(async (value) => {
    for (const notice of value?.notices ?? []) {
      if (notice.seq <= noticed) continue;
      noticed = notice.seq;
      send({ type: "notice", notice: { ...notice }, waiting: (await usage?.waiting()) ?? [] });
    }
  });
  return {
    async stop() {
      await events.stop();
      await health?.stop();
      await approvals?.stop();
      await notices?.stop();
    },
  };
}
