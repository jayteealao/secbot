/**
 * The tools that touch the outside: reading tools return outside content (web pages, mails,
 * files), which the content check reads before a job keeps it; outside actions send, buy, or
 * publish, and from a job that read outside content they need the reviewer's yes. The release
 * tables name them; a cell can declare more reading tools when it opens. The fixture reading tool
 * serves fixed test pages (tests and the test cell only).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import {
  OUTSIDE_ACTION_TOOLS,
  OUTSIDE_CONTENT_TOOLS,
  type OutsideKind,
} from "./release-defaults.ts";

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
