/**
 * `secbot jobs`: the person's job board. Live jobs come first in the order they run, then the jobs
 * that ended in the last 24 hours, each with its reason line. Cost shows against the cap of the
 * job's current tier, and `TIER` is the tier with the effort the model applied. The owner, with
 * the operator key: `--person <name>` for one person's board, `--household` for shared jobs.
 */
import type { CellClient, OperatorClient } from "../client.ts";
import type { Io } from "../io.ts";
import { columns, plain, RULE, WIDTH } from "../text.ts";

/** A row's reason line, as the cell words it. */
export interface BoardReason {
  readonly code: string;
  readonly text: string;
}

/** One job on the board (`GET /jobs`). */
export interface BoardRow {
  readonly number: number;
  readonly title: string;
  readonly priority: string;
  readonly tier: string;
  readonly effort: string;
  readonly try: string;
  readonly cost: number;
  readonly cap: number;
  readonly status: string;
  readonly reason: BoardReason | null;
  readonly shared?: string;
}

/** `GET /jobs` and `GET /ops/jobs?cell=<c>`. */
export interface BoardView {
  readonly person: string;
  readonly mode: string;
  readonly live: number;
  readonly waiting: number;
  readonly rows: readonly BoardRow[];
  readonly finished: readonly BoardRow[];
  readonly shown: number;
  readonly capacity: {
    readonly jobsAtOnce: number;
    readonly measured: number;
    readonly on: string;
  } | null;
  readonly templates: readonly { readonly name: string; readonly tier: string }[];
}

/** Where each column starts: #, TITLE, PRIORITY, TIER, TRY, COST/CAP, STATUS. */
export const BOARD_COLUMNS = [0, 4, 30, 42, 53, 58, 69] as const;
/** The longest title shown whole; a longer one keeps 21 characters and ends in `...`. */
export const TITLE_MAX = 24;
/** Reason and shared lines start here, under the title. */
const REASON_INDENT = 6;

/** A title cut to the column: at most 24 characters, a longer one ending in `...`. */
export const titleCell = (title: string): string => {
  const shown = plain(title);
  return shown.length > TITLE_MAX ? `${shown.slice(0, TITLE_MAX - 3)}...` : shown;
};

/** A cap as the board writes it: `$1`, `$1.50`, or `.25` under a dollar. */
export const capText = (usd: number): string => {
  if (usd < 1)
    return `.${Math.round(usd * 100)
      .toString()
      .padStart(2, "0")}`;
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
};

/** `$0.41/$1`, the job's cost against its cap. */
export const costCap = (cost: number, cap: number): string => `$${cost.toFixed(2)}/${capText(cap)}`;

/** A line under a row at the reason indent; wrapped only when it does not fit on one line. */
function indented(text: string): string[] {
  const shown = plain(text);
  if (REASON_INDENT + shown.length <= WIDTH) return [`${" ".repeat(REASON_INDENT)}${shown}`];
  const lines: string[] = [];
  let rest = shown;
  const room = WIDTH - REASON_INDENT;
  while (rest.length > 0) {
    let cut = rest.length <= room ? rest.length : rest.lastIndexOf(" ", room);
    if (cut <= 0) cut = Math.min(room, rest.length);
    lines.push(`${" ".repeat(REASON_INDENT)}${rest.slice(0, cut).trimEnd()}`);
    rest = rest.slice(cut).trimStart();
  }
  return lines;
}

/** One job's lines: the row, its shared line, and its reason line. */
export function rowLines(row: BoardRow): string[] {
  const lines = columns(
    [
      String(row.number),
      titleCell(row.title),
      row.priority,
      `${row.tier}/${row.effort}`,
      row.try,
      costCap(row.cost, row.cap),
      row.status,
    ],
    BOARD_COLUMNS,
  );
  if (row.shared !== undefined) lines.push(...indented(row.shared));
  if (row.reason !== null) lines.push(...indented(row.reason.text));
  return lines;
}

/** The board: the header, the capacity line, live rows, the last 24 hours, and the footer. */
export function boardLines(view: BoardView, operator: boolean, person?: string): string[] {
  const who = operator ? `${plain(view.person)} (operator key)` : plain(view.person);
  const empty = view.rows.length === 0 && view.finished.length === 0;
  const waiting = empty
    ? `[ waiting results: ${view.waiting} ]`
    : `[ results waiting: ${view.waiting} ]`;
  const lines = [`JOBS  ${who}  [ live: ${view.live} ] ${waiting}  [ ${plain(view.mode)} ]`, RULE];
  if (view.capacity !== null) {
    const { jobsAtOnce, measured, on } = view.capacity;
    lines.push(
      `[ ${jobsAtOnce} jobs at once; this cell was measured at ${measured} on ${plain(on)} ] nothing is held back`,
    );
  }
  if (empty) {
    lines.push(
      "no jobs running; 0 finished in the last 24 hours",
      `templates: ${view.templates.map((each) => `${plain(each.name)} (${plain(each.tier)})`).join(", ")}`,
    );
    return lines;
  }
  lines.push(
    ...columns(["#", "TITLE", "PRIORITY", "TIER", "TRY", "COST/CAP", "STATUS"], BOARD_COLUMNS),
  );
  for (const row of view.rows) lines.push(...rowLines(row));
  if (view.finished.length > 0) {
    lines.push("FINISHED (last 24 h)");
    for (const row of view.finished) lines.push(...rowLines(row));
  }
  const older =
    person === undefined ? "secbot activity" : `secbot activity --person ${plain(person)}`;
  lines.push(`showing ${view.shown}; older jobs: ${older}`);
  return lines;
}

/** `secbot jobs`: the device's own person's board. */
export async function jobsBoard(client: CellClient, io: Io): Promise<number> {
  const view = await client.request<BoardView>("GET", "/jobs");
  io.stdout(`${boardLines(view, false).join("\n")}\n`);
  return 0;
}

/** `secbot jobs --person <name>` or `--household`: the owner reads a board with the operator key. */
export async function jobsBoardOf(client: OperatorClient, io: Io, cell: string): Promise<number> {
  const view = await client.request<BoardView>("GET", `/ops/jobs?cell=${encodeURIComponent(cell)}`);
  // The household's shared jobs have no activity of their own to point at.
  io.stdout(`${boardLines(view, true, cell === "household" ? undefined : cell).join("\n")}\n`);
  return 0;
}
