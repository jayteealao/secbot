/**
 * History search: a read-only tool over the lead's own conversation, for the lead and for every
 * specialist on a brief. pi-durable has no search API; `Conversation.entries()` pages the
 * fork-aware history newest first (pi-durable v1.0.3 src/harness/types.ts:533-539), and this tool
 * filters the text.
 */
import type { Context } from "@earendil-works/chord";
import { type Message, Type } from "@earendil-works/pi-ai";
import {
  type Cursor,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  type Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";

/** At most this many entries are read per search. */
export const SCAN_LIMIT = 2_000;
const PAGE = 200;
const SNIPPET = 500;

export function messageText(message: Message | undefined): string {
  if (message === undefined) return "";
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }
  if (message.role === "assistant") {
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }
  return "";
}

export interface HistoryHit {
  readonly entryId: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Entries of the lead's conversation whose text contains every term, newest first. */
export async function searchHistory(
  harness: Harness,
  query: string,
  limit: number,
  context: Context,
): Promise<HistoryHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const lead = await harness.conversation(ROOT_CONVERSATION_ID, context);
  if (lead === undefined) return [];
  const hits: HistoryHit[] = [];
  let cursor: Cursor | undefined;
  let scanned = 0;
  do {
    const page = await lead.entries({}, PAGE, cursor, context);
    for (const entry of page.items as readonly EntryRecord[]) {
      scanned++;
      if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
      const message = entry.model?.[0];
      const text = messageText(message);
      const lower = text.toLowerCase();
      if (text === "" || !terms.every((term) => lower.includes(term))) continue;
      hits.push({
        entryId: Number(entry.id),
        role: message?.role === "user" ? "user" : "assistant",
        text: text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text,
      });
      if (hits.length >= limit) return hits;
    }
    cursor = page.next;
  } while (cursor !== undefined && scanned < SCAN_LIMIT);
  return hits;
}

/** `harness()` returns the open harness; the extension is built before the harness opens. */
export function createHistoryExtension(harness: () => Harness): Extension {
  const searchTool = defineTool({
    name: "search_history",
    description:
      "Search the lead's conversation history for earlier messages. Returns the matching messages, newest first. Every word of the query must appear.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Words to look for." }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: "At most this many results (default 10).",
        }),
      ),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async (args, _api, context) => {
      const hits = await searchHistory(harness(), args.query, args.limit ?? 10, context);
      const text =
        hits.length === 0
          ? `No messages in the lead's history match "${args.query}".`
          : hits.map((hit) => `#${hit.entryId} ${hit.role}: ${hit.text}`).join("\n\n");
      return { content: [{ type: "text", text }], details: { matches: hits.length } };
    },
  });
  return defineExtension({ name: "secbot-history", tools: [searchTool] });
}
