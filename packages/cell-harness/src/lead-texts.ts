/**
 * What the lead's job tools say, and the small helpers they share: the refusal and answer texts
 * (tests and the person-side routes read the same words) and the shapes every tool result takes.
 */
import { Type } from "@earendil-works/pi-ai";
import type { Tx } from "@earendil-works/pi-durable";
import { JobBoardDoc, type JobRow } from "./docs.ts";
import type { ResumeRefusal } from "./job-board.ts";
import { payerText } from "./shared-split.ts";
import { STOP_RUNNING } from "./stop.ts";

/** What the lead hears after proposing a shared job. */
export const proposedText = (n: number, other: string) =>
  `job ${n} waits for ${other} to agree to share the cost; tell the person you asked them.`;

/** What the lead hears after giving the person a shared offer. */
export const offerText = (n: number) =>
  `Ask the person in your own words now; the chat adds "[ job ${n} shared ]" and their /join or /decline goes to the household.`;

/** The lead's refusal when a move would change a shared job both people agreed to. */
export const SHARED_KEEPS_TIER =
  "a shared job keeps the tier both people agreed to; ask the person whether to start a new shared job.";

/** The lead's refusal of a question move on a shared job: the household agent asks nobody. */
export const SHARED_NO_QUESTIONS =
  "a shared job asks no questions; the household agent states its assumptions in its answer.";

/** The lead's refusal of a risky mark on a shared job: the household marks and reviews it. */
export const SHARED_NO_MARK =
  "a shared job's result is marked and reviewed in the household before either lead gets it.";

/** The other person's refusal: only the requesting lead restarts a shared job. */
export const sharedRestartOwnerText = (requester: string) =>
  `only ${requester}'s lead restarts this shared job.`;

/** The requesting lead's refusal once the shared job's one restart is used. */
export const sharedRestartUsedText = (n: number) =>
  `Refused: shared job ${n} has used its restart. Ask the person in your own words whether to start a new shared job at a higher tier.`;

/** The lead's refusal while a shared job waits for the other person's yes: nothing runs yet. */
export const sharedNotStartedText = (n: number, other: string) =>
  `job ${n} waits for ${other} to agree to share the cost; nothing runs yet.`;

/** Who pays a shared job, from this person's side. */
export function sharedPayerText(link: NonNullable<JobRow["shared"]>): string {
  return payerText(link.payer, link.with);
}

/** The lead's note when a job will wait above a limit before it starts. */
export const JOB_WAITS_NOTE =
  " The person is over their monthly limit, so the job waits until the limit rises or the month resets.";

/** The longest answer to a job's question, from the lead or the person. */
export const ANSWER_MAX_CHARS = 2_000;

/** What the lead hears after ask_person. */
export const askPersonText = (n: number) =>
  `Ask the person in your own words now; the chat adds "[ job ${n} asks ]" and their /answer goes to the job.`;

/** What the lead hears when a resume is refused. */
export function resumeRefusalText(n: number, reason: ResumeRefusal, status = ""): string {
  switch (reason) {
    case "no-job":
      return `No job ${n} on the board.`;
    case "locked":
      return STOP_RUNNING;
    case "paused":
      return `job ${n} is paused, not stopped: raise it with set_job or restart it with restart_job.`;
    default:
      return `job ${n} is ${status || "not stopped"}; only a stopped or blocked job resumes.`;
  }
}

/** The lead's refusal when a job has used both escalations: the job has stopped. */
export const exhaustedText = (n: number) =>
  `Refused: job ${n} has used its raise and its restart. It has stopped; ask the person in your own words what to do — the chat adds the /answer line.`;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
export const refusal = (value: string) => ({ ...text(value), isError: true });

export const literals = <T extends string>(values: readonly T[], description: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );

/** A job number parameter of a lead tool. */
export const jobParameter = Type.Integer({ minimum: 1, description: "The job's number." });

/** The row of job `n` in a commit, or an error naming the jobs that exist. */
export async function rowOrError(tx: Tx, n: number): Promise<JobRow | { readonly error: string }> {
  const board = await tx.doc(JobBoardDoc);
  const row = Object.hasOwn(board.jobs, String(n)) ? board.jobs[String(n)] : undefined;
  if (row !== undefined) return row;
  const numbers = Object.keys(board.jobs);
  return {
    error:
      numbers.length === 0
        ? `No job ${n}: the board has no jobs.`
        : `No job ${n}. Jobs on the board: ${numbers.join(", ")}.`,
  };
}
