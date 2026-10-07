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

/**
 * At most this many entries are read per search. A search that stops at this limit says so and
 * names the oldest entry it read, so the caller can continue further back with `before`.
 */
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

export interface HistorySearch {
  readonly hits: HistoryHit[];
  /** Entries read for this search (entries at or after `before` are not counted). */
  readonly scanned: number;
  /** True when the scan stopped at the scan limit with older history left unread. */
  readonly truncated: boolean;
  /** The oldest entry read; pass it as `before` to continue further back. */
  readonly oldestEntryId: number | undefined;
}

/**
 * Entries of the lead's conversation whose text contains every term, newest first, starting
 * below `before` when it is given.
 */
export async function searchHistoryWindow(
  harness: Harness,
  query: string,
  options: { readonly limit: number; readonly before?: number; readonly scanLimit?: number },
  context: Context,
): Promise<HistorySearch> {
  const scanLimit = options.scanLimit ?? SCAN_LIMIT;
  const empty: HistorySearch = { hits: [], scanned: 0, truncated: false, oldestEntryId: undefined };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return empty;
  const lead = await harness.conversation(ROOT_CONVERSATION_ID, context);
  if (lead === undefined) return empty;
  const hits: HistoryHit[] = [];
  let cursor: Cursor | undefined;
  let scanned = 0;
  let oldestEntryId: number | undefined;
  do {
    const page = await lead.entries({}, PAGE, cursor, context);
    for (const entry of page.items as readonly EntryRecord[]) {
      const entryId = Number(entry.id);
      if (options.before !== undefined && entryId >= options.before) continue;
      if (scanned >= scanLimit) return { hits, scanned, truncated: true, oldestEntryId };
      scanned++;
      oldestEntryId = entryId;
      if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
      const message = entry.model?.[0];
      const text = messageText(message);
      const lower = text.toLowerCase();
      if (text === "" || !terms.every((term) => lower.includes(term))) continue;
      hits.push({
        entryId,
        role: message?.role === "user" ? "user" : "assistant",
        text: text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text,
      });
      if (hits.length >= options.limit) return { hits, scanned, truncated: false, oldestEntryId };
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { hits, scanned, truncated: false, oldestEntryId };
}

/** Entries of the lead's conversation whose text contains every term, newest first. */
export async function searchHistory(
  harness: Harness,
  query: string,
  limit: number,
  context: Context,
): Promise<HistoryHit[]> {
  return (await searchHistoryWindow(harness, query, { limit }, context)).hits;
}

/** The tool's answer; a search that stopped early says so instead of reporting no match. */
export function historyAnswer(query: string, result: HistorySearch): string {
  const found = result.hits.map((hit) => `#${hit.entryId} ${hit.role}: ${hit.text}`).join("\n\n");
  if (!result.truncated) {
    return result.hits.length === 0 ? `No messages in the lead's history match "${query}".` : found;
  }
  const more =
    `Searched only the newest ${result.scanned} entries; older history was not read. ` +
    `To search further back, call search_history again with before: ${result.oldestEntryId}.`;
  return result.hits.length === 0
    ? `No messages in the searched part of the lead's history match "${query}". ${more}`
    : `${found}\n\n${more}`;
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
      before: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Search only entries older than this entry number (to continue a search).",
        }),
      ),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async (args, _api, context) => {
      const result = await searchHistoryWindow(
        harness(),
        args.query,
        { limit: args.limit ?? 10, ...(args.before === undefined ? {} : { before: args.before }) },
        context,
      );
      return {
        content: [{ type: "text", text: historyAnswer(args.query, result) }],
        details: {
          matches: result.hits.length,
          truncated: result.truncated,
          scanned: result.scanned,
        },
      };
    },
  });
  return defineExtension({ name: "secbot-history", tools: [searchTool] });
}
