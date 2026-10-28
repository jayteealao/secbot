/**
 * The interrupt bookmark. When a person's message reaches the lead while it is busy, code records
 * where the lead was: the turn (the run's first input), the receipts of that turn still running
 * or unread, and the jobs started in that turn whose results were not pulled. The lead adds one
 * sentence with `note_bookmark`, sees the bookmark at the top of every prompt, and clears it with
 * `resume_work` once it is back on the work (a newer interruption replaces it).
 *
 * Hooks cannot commit (installed pi-durable dist/harness/types.d.ts:531, `HookApi extends
 * DocumentReader`), so the host writes the bookmark before it submits the message.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { type Bookmark, BookmarkDoc, JobBoardDoc } from "./docs.ts";
import { openReceipts } from "./receipts.ts";

/** The bookmark as the lead reads it, in its prompt and from `resume_work`. */
export function bookmarkText(bookmark: Bookmark): string {
  const receipts = bookmark.receipts.length === 0 ? "none" : bookmark.receipts.join(", ");
  const jobs = bookmark.jobIds.length === 0 ? "none" : bookmark.jobIds.join(", ");
  return [
    `The person interrupted you at ${new Date(bookmark.at).toISOString().slice(0, 16)}Z during turn ${bookmark.turn}.`,
    `Receipts of that turn still open: ${receipts}. Jobs you started then: ${jobs}.`,
    bookmark.note === null
      ? "Add one sentence on what you were doing with note_bookmark."
      : `Your note: ${bookmark.note}`,
  ].join("\n");
}

/**
 * Records the bookmark when the lead is busy; returns it, or null when the lead was idle (nothing
 * is interrupted, and an existing bookmark stays).
 */
export async function recordInterruption(
  cell: { readonly person: string; readonly harness: Harness },
  now: number,
  context: Context,
): Promise<Bookmark | null> {
  const { harness } = cell;
  const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
  const first = live?.run?.inputs[0];
  if (first === undefined) return null;
  const turn = Number(first);
  const receipts = (await openReceipts(harness, context))
    .filter((receipt) => receipt.turn === turn)
    .map((receipt) => receipt.key);
  let replaced = false;
  const bookmark = await harness.commit(async (tx) => {
    const board = await tx.doc(JobBoardDoc);
    const jobIds = Object.values(board.jobs)
      .filter((row) => row.turn === turn && (row.result === null || row.result.pulledAt === null))
      .map((row) => row.number)
      .sort((a, b) => a - b);
    const doc = await tx.doc(BookmarkDoc);
    replaced = doc.bookmark !== null;
    const next: Bookmark = { turn, at: now, receipts, jobIds, note: null };
    doc.bookmark = next;
    return { ...next, receipts: [...receipts], jobIds: [...jobIds] };
  }, context);
  logEvent("bookmark.recorded", {
    cell: cell.person,
    turn,
    receipts: bookmark.receipts.length,
    jobs: bookmark.jobIds.length,
    replaced,
  });
  return bookmark;
}

/** The lead's `note_bookmark` and `resume_work`. */
export function createBookmarkExtension(person: string, now: () => number): Extension {
  const note = defineTool({
    name: "note_bookmark",
    description:
      "Add one sentence to your interrupt bookmark: what you were doing when the person interrupted you.",
    parameters: Type.Object({
      sentence: Type.String({ minLength: 1, maxLength: 300, description: "One sentence." }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const done = await api.commit(async (tx) => {
        const doc = await tx.doc(BookmarkDoc);
        if (doc.bookmark === null) return false;
        doc.bookmark.note = args.sentence.trim();
        return true;
      }, context);
      return {
        content: [
          {
            type: "text",
            text: done ? "Noted on your bookmark." : "No bookmark: nothing was interrupted.",
          },
        ],
        ...(done ? {} : { isError: true }),
      };
    },
  });
  const resume = defineTool({
    name: "resume_work",
    description:
      "Get back to what you were doing before the person interrupted you: returns your bookmark and clears it.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const taken = await api.commit(async (tx) => {
        const doc = await tx.doc(BookmarkDoc);
        if (doc.bookmark === null) return null;
        const bookmark: Bookmark = {
          ...doc.bookmark,
          receipts: [...doc.bookmark.receipts],
          jobIds: [...doc.bookmark.jobIds],
        };
        doc.bookmark = null;
        return bookmark;
      }, context);
      if (taken === null) {
        return { content: [{ type: "text", text: "No bookmark: nothing was interrupted." }] };
      }
      logEvent("bookmark.resumed", {
        cell: person,
        turn: taken.turn,
        waited_ms: Math.max(0, now() - taken.at),
        had_note: taken.note !== null,
      });
      return {
        content: [{ type: "text", text: `Resume from your bookmark:\n${bookmarkText(taken)}` }],
        details: { turn: taken.turn },
      };
    },
  });
  return defineExtension({ name: "secbot-bookmark", tools: [note, resume] });
}
