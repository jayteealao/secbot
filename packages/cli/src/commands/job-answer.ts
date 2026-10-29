/**
 * Answering a job's question from `secbot chat`. When the lead puts a job's question to the
 * person, the chat prints the lead's own words, then a line with the job's number; only an exact
 * `/answer <#> <text>` answers it, through the cell's answer route, never through the lead. A line
 * that only looks like one is not sent at all, and a plain line never answers a job.
 */
import type { CellClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";

/** The longest answer the cell takes, in characters. */
export const JOB_ANSWER_LIMIT = 2_000;

export const ANSWER_NOT_SENT = "not sent: answer with /answer <#> <text>";

const JOB_ANSWER = /^\/answer ([1-9][0-9]{0,8}) +(\S.*)$/s;
const JOB_ANSWER_LIKE = /^\/answer\b/i;
const LINE = 78;

/** Control characters and line breaks, so a title prints as one plain line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control codes are what it removes.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * What a chat line is: an exact answer to a job's question, a line that only looks like one (not
 * sent), or anything else.
 */
export function answerJobOf(
  line: string,
):
  | { readonly kind: "answer"; readonly job: number; readonly text: string }
  | { readonly kind: "malformed" }
  | { readonly kind: "other" } {
  const exact = JOB_ANSWER.exec(line);
  if (exact !== null) return { kind: "answer", job: Number(exact[1]), text: exact[2] ?? "" };
  return JOB_ANSWER_LIKE.test(line) ? { kind: "malformed" } : { kind: "other" };
}

/** The line under the lead's question: which job asks and how to answer it. */
export const questionLine = (job: number): string =>
  `[ job ${job} asks ] answer with /answer ${job} <text>`;

/** `[ answered ] #<n> <title> continues`, the title cut to keep the line within 78 columns. */
export function answeredLine(job: number, title: string): string {
  const head = `[ answered ] #${job} `;
  const tail = " continues";
  const plain = title.replace(CONTROL, " ").trim();
  const room = LINE - head.length - tail.length;
  const shown = plain.length > room ? `${plain.slice(0, room - 1)}…` : plain;
  return `${head}${shown}${tail}`;
}

/** Sends the person's answer to the cell; the confirmation goes to stdout, a refusal to stderr. */
export async function answerJob(
  client: CellClient,
  io: Io,
  job: number,
  text: string,
): Promise<void> {
  if (text.length > JOB_ANSWER_LIMIT) {
    io.stderr(`not sent: an answer is at most ${JOB_ANSWER_LIMIT} characters\n`);
    return;
  }
  try {
    const answered = await client.request<{ job: number; title: string }>(
      "POST",
      `/jobs/${job}/answer`,
      { text },
    );
    io.stdout(`${answeredLine(answered.job, answered.title)}\n`);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr(`secbot: ${error.message.replace(CONTROL, " ")}\n`);
  }
}
