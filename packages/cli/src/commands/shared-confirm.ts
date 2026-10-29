/**
 * Answering a shared-job offer from `secbot chat`. When the other person's lead gives the person a
 * shared job, the chat prints the lead's own words, then a line with the job's number; only an
 * exact `/join <#>` or `/decline <#>` answers it, through the cell's routes, never through the
 * lead. A line that only looks like one is not sent at all, and a plain line never answers.
 */
import type { CellClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";

export const SHARED_NOT_SENT = "not sent: answer with /join <#> or /decline <#>";

const SHARED = /^\/(join|decline) ([1-9][0-9]{0,8})$/;
const SHARED_LIKE = /^\/(join|decline)\b/i;

/** Control characters and line breaks, so a title or a name prints as one plain line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control codes are what it removes.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const plain = (text: string) => text.replace(CONTROL, " ").trim();

/** What a chat line is: an exact join or decline, a line that only looks like one, or neither. */
export function sharedOf(
  line: string,
):
  | { readonly kind: "join" | "decline"; readonly job: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "other" } {
  const exact = SHARED.exec(line);
  if (exact !== null) {
    return { kind: exact[1] === "join" ? "join" : "decline", job: Number(exact[2]) };
  }
  return SHARED_LIKE.test(line) ? { kind: "malformed" } : { kind: "other" };
}

/**
 * The line under the lead's words: which job is shared and how to answer. When the person's own
 * limit is reached (`all`), the proposing person pays all, and the line breaks where the approved
 * text breaks it.
 */
export function sharedLine(job: number, from: string, payer: "half" | "all"): string {
  const who = plain(from);
  return payer === "all"
    ? `[ job ${job} shared ] your limit is reached, so ${who} pays all; /join ${job} to see it on\n  your board, /decline ${job} to leave it`
    : `[ job ${job} shared ] /join ${job} to share the cost, /decline ${job} to leave it to ${who}`;
}

/** `[ joined ] #<n> <title>; you pay half` (or `you pay all`, or `<from> pays all`). */
export function joinedLine(
  job: number,
  title: string,
  payer: "half" | "you" | "them",
  from: string,
): string {
  const pays =
    payer === "half" ? "you pay half" : payer === "you" ? "you pay all" : `${plain(from)} pays all`;
  return `[ joined ] #${job} ${plain(title)}; ${pays}`;
}

/** `[ declined ] #<n> <title>; <from>'s lead was told`. */
export const declinedLine = (job: number, title: string, from: string): string =>
  `[ declined ] #${job} ${plain(title)}; ${plain(from)}'s lead was told`;

/** Sends the person's join or decline to the cell; the confirmation to stdout, a refusal to stderr. */
export async function answerShared(
  client: CellClient,
  io: Io,
  job: number,
  join: boolean,
): Promise<void> {
  try {
    const answered = await client.request<{
      job: number;
      title: string;
      from: string;
      payer: "half" | "you" | "them";
    }>("POST", `/jobs/${job}/${join ? "join" : "decline"}`);
    io.stdout(
      `${
        join
          ? joinedLine(answered.job, answered.title, answered.payer, answered.from)
          : declinedLine(answered.job, answered.title, answered.from)
      }\n`,
    );
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr(`secbot: ${error.message.replace(CONTROL, " ")}\n`);
  }
}
