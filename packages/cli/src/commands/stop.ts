/**
 * `secbot stop`: every running job of the person and the lead's current turn stop now, with their
 * state kept; routines and reminders keep their schedule. There is no confirmation prompt. The
 * owner, with the operator key: `secbot stop --all` stops every cell of the household, in every
 * fleet, and names any cell that did not answer.
 */
import type { CellClient, OperatorClient } from "../client.ts";
import type { Io } from "../io.ts";
import { plain } from "../text.ts";

/** `3 jobs`, `1 job`. */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `a`, `a and b`, `a, b and c`. */
export const listed = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The person's stop lines. */
export function stopLines(answer: { readonly jobs: number; readonly turn: boolean }): string[] {
  if (answer.jobs === 0 && !answer.turn) {
    return ["[ stopped ] nothing was running. Routines and reminders keep their schedule."];
  }
  const parts = [
    ...(answer.jobs > 0 ? [count(answer.jobs, "job")] : []),
    ...(answer.turn ? ["the lead's current turn"] : []),
  ];
  return [
    `[ stopped ] ${parts.join(" and ")}. Their state is kept.`,
    "  Routines and reminders keep their schedule.",
    ...(answer.jobs > 0 ? ["  Restart one: secbot jobs restart <#>"] : []),
  ];
}

/** One cell's part of the owner's stop. */
export interface CellStop {
  readonly cell: string;
  readonly jobs: number;
  readonly turn: boolean;
  readonly shared: boolean;
}

/** The owner's stop lines: the household's totals, then one line per cell that stopped. */
export function stopAllLines(cells: readonly CellStop[]): string[] {
  const jobs = cells.reduce((sum, each) => sum + each.jobs, 0);
  const turns = cells.filter((each) => each.turn).length;
  return [
    `[ stopped ] household: ${count(jobs, "job")} and ${count(turns, "lead turn")}. Their state is kept.`,
    ...cells.map((each) => {
      const what = each.shared
        ? count(each.jobs, "shared job")
        : `${count(each.jobs, "job")}${each.turn ? ", lead turn" : ""}`;
      return `  ${plain(each.cell).padEnd(10)}${what}`;
    }),
  ];
}

/** `secbot stop`. */
export async function stopOwn(client: CellClient, io: Io): Promise<number> {
  const answer = await client.request<{ jobs: number; turn: boolean }>("POST", "/stop");
  io.stdout(`${stopLines(answer).join("\n")}\n`);
  return 0;
}

/** `secbot stop --all`: exit code 1 when a cell did not answer; running it again is safe. */
export async function stopAll(client: OperatorClient, io: Io): Promise<number> {
  const answer = await client.request<{ cells: CellStop[]; missing: string[] }>(
    "POST",
    "/ops/stop",
  );
  io.stdout(`${stopAllLines(answer.cells).join("\n")}\n`);
  if (answer.missing.length === 0) return 0;
  const stopped = answer.cells.map((each) => plain(each.cell));
  io.stderr(
    `secbot: stop incomplete: ${listed(answer.missing.map(plain))} did not answer; ${
      stopped.length === 0 ? "no cell" : listed(stopped)
    } stopped.\n  run secbot stop --all again\n`,
  );
  return 1;
}
