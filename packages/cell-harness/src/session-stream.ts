/**
 * Frames for a chat session: the lead's answer as it streams, its end, relayed specialist
 * follow-ups, and the waiting-for-the-model state. Built from pi-durable's agent events for the
 * lead's root conversation (`watchEvents`, one batch per commit; a late joiner starts from the
 * current view and nothing is replayed: pi-durable README "Watching a Conversation"). This module
 * only reports what was committed; it never decides where a message goes.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, ROOT_CONVERSATION_ID, watchEvents } from "@earendil-works/pi-durable";
import { leadMessageOf } from "./delivery.ts";
import { ModelHealthDoc } from "./docs.ts";

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
  | { readonly type: "error"; readonly message: string };

export interface SessionStream {
  stop(): Promise<void>;
}

/**
 * Watches the lead and calls `send` with each frame. `delivered` runs after an answer or a
 * follow-up frame was sent, so the caller can advance delivery cursors.
 */
export async function openSessionStream(
  harness: Harness,
  send: (frame: Frame) => void,
  delivered: (entryId: number) => void | Promise<void> = () => {},
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
  return {
    async stop() {
      await events.stop();
      await health?.stop();
    },
  };
}
