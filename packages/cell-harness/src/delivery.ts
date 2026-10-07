/**
 * Missed messages. Each device has a cursor in `secbot.delivery`: the newest lead message a session
 * or the `missed` command delivered to it. `missedMessages()` lists the lead's answers and relayed
 * specialist follow-ups after the cursor, oldest first, and advances the cursor.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  Conversation,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import { DeliveryDoc } from "./docs.ts";
import { HANDOFF_REPORT_PREFIX, textOf } from "./handoff.ts";
import { messageText } from "./history-search.ts";

/** At most this many messages are listed at once (the oldest ones not yet delivered). */
export const MISSED_LIMIT = 100;

export type LeadMessage =
  | { readonly kind: "answer"; readonly entryId: number; readonly text: string }
  | {
      readonly kind: "followup";
      readonly entryId: number;
      readonly from: string;
      readonly text: string;
    };

const FOLLOWUP = /^\[handoff ([a-z][a-z0-9-]*) ([^\]]*)\] ?/;

/** A lead transcript entry as something the person sees, or undefined for everything else. */
export function leadMessageOf(entry: EntryRecord): LeadMessage | undefined {
  const message = entry.model?.[0];
  const entryId = Number(entry.id);
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const answer = message as AssistantMessage;
    const text = textOf(answer);
    const final = answer.stopReason === "stop" || answer.stopReason === "length";
    return final && text !== "" ? { kind: "answer", entryId, text } : undefined;
  }
  if (entry.kind === "pi.user" && message?.role === "user") {
    const text = messageText(message);
    if (!text.startsWith(HANDOFF_REPORT_PREFIX)) return undefined;
    const parsed = FOLLOWUP.exec(text);
    if (parsed === null) return undefined;
    return {
      kind: "followup",
      entryId,
      from: parsed[1] ?? "specialist",
      text: text.slice(parsed[0].length) || parsed[2] || "",
    };
  }
  return undefined;
}

export async function markDelivered(
  harness: Harness,
  device: string,
  entryId: number,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const delivery = await tx.doc(DeliveryDoc);
    const current = delivery.devices[device];
    if (current === undefined || Number(current) < entryId) {
      delivery.devices[device] = entryId as EntryId;
    }
  }, context);
}

export interface MissedPage {
  /** The oldest missed messages, oldest first, at most `MISSED_LIMIT`. */
  readonly messages: LeadMessage[];
  /** Newer missed messages left for the next call; the cursor stops before them. */
  readonly remaining: number;
}

/**
 * The oldest messages after the device's cursor, and how many newer ones are left. The cursor
 * moves only past the messages returned, so a long absence is read page by page, never skipped.
 */
export async function missedPage(
  harness: Harness,
  lead: Conversation,
  device: string,
  context: Context,
  limit: number = MISSED_LIMIT,
): Promise<MissedPage> {
  const cursorId = (await harness.snapshot(DeliveryDoc, context))?.devices[device];
  const after = cursorId === undefined ? -1 : Number(cursorId);
  // History pages newest first, so every message after the cursor is read and the oldest are kept.
  const newestFirst: LeadMessage[] = [];
  let cursor: Cursor | undefined;
  scan: do {
    const page = await lead.entries({}, 200, cursor, context);
    for (const entry of page.items) {
      if (Number(entry.id) <= after) break scan;
      const message = leadMessageOf(entry);
      if (message !== undefined) newestFirst.push(message);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  const oldestFirst = newestFirst.reverse();
  const messages = oldestFirst.slice(0, limit);
  const newest = messages.at(-1);
  if (newest !== undefined) await markDelivered(harness, device, newest.entryId, context);
  return { messages, remaining: oldestFirst.length - messages.length };
}

export async function missedMessages(
  harness: Harness,
  lead: Conversation,
  device: string,
  context: Context,
): Promise<LeadMessage[]> {
  return (await missedPage(harness, lead, device, context)).messages;
}
