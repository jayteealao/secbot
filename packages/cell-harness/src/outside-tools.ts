/**
 * The tools that touch the outside: reading tools return outside content (web pages, mails,
 * files), which the content check reads before a job keeps it; outside actions send, buy, or
 * publish, and from a job that read outside content they need the reviewer's yes. The release
 * tables name them; a cell can declare more reading tools when it opens. The fixture reading tool
 * serves fixed test pages, and the fixture lookup tools fail on purpose or answer slowly (tests and
 * the test cell only).
 */

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { JobBoardDoc } from "./docs.ts";
import {
  OUTSIDE_ACTION_TOOLS,
  OUTSIDE_CONTENT_TOOLS,
  type OutsideKind,
} from "./release-defaults.ts";
import { jobOf } from "./telemetry.ts";

/** The kind of outside content a tool returns, or null when it is not a reading tool. */
export function readingKindOf(
  name: string,
  extra: Readonly<Record<string, OutsideKind>> = {},
): OutsideKind | null {
  if (Object.hasOwn(extra, name)) return extra[name] ?? null;
  return Object.hasOwn(OUTSIDE_CONTENT_TOOLS, name) ? (OUTSIDE_CONTENT_TOOLS[name] ?? null) : null;
}

/** True for a tool that sends, buys, or publishes. */
export const isOutsideAction = (name: string): boolean => Object.hasOwn(OUTSIDE_ACTION_TOOLS, name);

/**
 * The outside-content review: for an outside action whose calling job has read outside content,
 * the line the reviewer is told (`job 3 read outside content (page, mail)`); null for any other
 * call. The guard then asks the reviewer whatever the decision model scores, in every mode.
 */
export async function outsideReviewOf(
  call: { readonly tool: string; readonly conversationId?: ConversationId },
  api: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<string | null> {
  if (!isOutsideAction(call.tool) || call.conversationId === undefined) return null;
  const n = await jobOf(api, call.conversationId, context);
  if (n === null) return null;
  const outside = (await api.snapshot(JobBoardDoc, context))?.jobs[String(n)]?.outside;
  if (outside == null) return null;
  return `job ${n} read outside content (${outside.kinds.join(", ")})`;
}

/**
 * The fixture reading tool: `read_fixture_page` returns one of the given pages, as a web reading
 * tool would. It reports no progress output or details, and reads nothing else.
 */
export function createFixtureReaderExtension(pages: Readonly<Record<string, string>>): Extension {
  const readPage = defineTool({
    name: "read_fixture_page",
    description: "Read one web page by its name and return its text.",
    parameters: Type.Object({
      page: Type.String({ minLength: 1, description: "The page's name." }),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async (args) => {
      if (!Object.hasOwn(pages, args.page)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No page named ${args.page}. Pages: ${Object.keys(pages).join(", ")}.`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: pages[args.page] ?? "" }] };
    },
  });
  return defineExtension({ name: "secbot-fixture-reader", tools: [readPage] });
}

/** The fixture lookup's one answer: always the same error, so three calls trip the loop guard. */
export const FIXTURE_LOOKUP_ERROR = "Lookup failed: temporary error. Try again with the same id.";

/**
 * The fixture lookup tools (tests and the test cell only): `fixture_lookup` always fails with the
 * same error, so a live job can be made to fail three times in a row; `fixture_slow_lookup` waits
 * `slowMs` and then answers, so a live job stays running while a stop or a capacity level arrives.
 * Both read nothing and act on nothing, and report no progress output.
 */
export function createFixtureToolsExtension(options: { readonly slowMs: number }): Extension {
  const lookup = defineTool({
    name: "fixture_lookup",
    description: "Look up one record by its id.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "The record's id." }),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async () => ({
      content: [{ type: "text" as const, text: FIXTURE_LOOKUP_ERROR }],
      isError: true,
    }),
  });
  const slowLookup = defineTool({
    name: "fixture_slow_lookup",
    description: "Look up options for one topic. It takes a while to answer.",
    parameters: Type.Object({
      topic: Type.String({ minLength: 1, description: "The topic to look up." }),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async (args, _api, context) => {
      await waitFor(options.slowMs, context.abortSignal);
      return {
        content: [
          { type: "text" as const, text: `Lookup result for ${args.topic}: three options found.` },
        ],
      };
    },
  });
  return defineExtension({ name: "secbot-fixture-tools", tools: [lookup, slowLookup] });
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
