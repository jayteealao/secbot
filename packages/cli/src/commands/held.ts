/**
 * Held calls on the command line: the block `secbot chat` prints when a call waits for the
 * person, the answer confirmations, and the HELD CALLS section of `secbot missed`. Plain UTF-8,
 * ASCII framing, no color, no control codes, every line at most 80 columns (78 here, as the dash
 * rule). A plain chat line is never an answer: only an exact `/allow N`, `/always N`, or
 * `/deny N` is, and it goes to the cell's approval route, never to the lead.
 */
import type { CellClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";
import { matchText, RULE, type Rule, rightAligned, toolText } from "../text.ts";

export type HeldCall = {
  number: number;
  requestId: string;
  agent: string;
  tool: string;
  summary: string;
  arguments: unknown;
  reason: string;
  reasonSource: string;
  always: { offered: boolean; rule: Rule | null; note: string | null };
  heldAt: number;
  expiresAt: number;
  remainingMs: number;
  status: string;
};

export type AnswerChoice = "allow" | "always" | "deny";

/** An exact answer line. */
const ANSWER = /^\/(allow|always|deny) ([1-9][0-9]{0,5})$/;
/** A line that looks like an answer but is not exact: refused here, never sent to the lead. */
const ANSWER_LIKE = /^\/(allow|always|deny)\b/i;
export const NOT_SENT = "not sent: answer with /allow N, /always N, or /deny N";

/**
 * What a chat line is: an exact answer to a held call, a line that only looks like one (not
 * sent), or a message for the lead (sent unchanged).
 */
export function answerOf(
  line: string,
):
  | { readonly kind: "answer"; readonly choice: AnswerChoice; readonly number: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "message" } {
  const exact = ANSWER.exec(line);
  if (exact !== null) {
    return { kind: "answer", choice: exact[1] as AnswerChoice, number: Number(exact[2]) };
  }
  return ANSWER_LIKE.test(line) ? { kind: "malformed" } : { kind: "message" };
}

const LINE = 78;
const VALUE = 13;
const ANSWER_TEXT = 26;

/** Control characters (a value from an agent could hold them) shown as `?`. */
const plain = (text: string) => text.replace(/\p{Cc}/gu, "?");

/** `23 h 58 m`. */
export function timeToLapse(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/** `the lead`, `the research specialist`. */
export function agentPhrase(agent: string): string {
  if (agent === "lead") return "the lead";
  if (agent === "other" || agent === "") return "an agent";
  return `the ${plain(agent)} specialist`;
}

/**
 * Lines that start with `prefix` and continue at `indent`, each at most LINE wide. Units are kept
 * whole on a line when they fit; a unit too wide for any line is broken into its words.
 */
export function fill(prefix: string, units: readonly string[], indent: number): string[] {
  const room = LINE - indent;
  const pieces = units.flatMap((unit) => (unit.length > room ? unit.split(/\s+/) : [unit]));
  const lines: string[] = [];
  const margin = " ".repeat(indent);
  let line = prefix;
  // A prefix that ends in a space (or none) takes the first piece with no space before it.
  let fresh = prefix === "" || prefix.endsWith(" ");
  for (const piece of pieces.filter((each) => each !== "")) {
    let rest = piece;
    while (rest.length > room) {
      if (line.trim() !== "") lines.push(line);
      lines.push(margin + rest.slice(0, room));
      line = margin;
      fresh = true;
      rest = rest.slice(room);
    }
    const next = fresh ? line + rest : `${line} ${rest}`;
    if (next.length <= LINE) {
      line = next;
    } else {
      lines.push(line);
      line = margin + rest;
    }
    fresh = false;
  }
  lines.push(line);
  return lines.map((each) => each.trimEnd()).filter((each, index) => index === 0 || each !== "");
}

const words = (text: string) => plain(text).split(/\s+/);

/** One argument as `key = value`; strings with spaces or quotes are quoted. */
function argumentText(key: string, value: unknown): string {
  if (typeof value === "string") {
    const shown = /[\s"\\]/.test(value) || value === "" ? JSON.stringify(value) : value;
    return `${plain(key)} = ${plain(shown)}`;
  }
  return `${plain(key)} = ${plain(JSON.stringify(value) ?? "null")}`;
}

const answerCell = (text: string) =>
  text.length < ANSWER_TEXT - VALUE ? text.padEnd(ANSWER_TEXT - VALUE) : `${text} `;

/** The rule allow always adds, in two units: the agent and tool, then the match and verdict. */
const ruleUnits = (rule: Rule) => [
  `${plain(rule.agent)} ${plain(toolText(rule.tool))}`,
  `(${plain(matchText(rule.match))}) -> permit`,
];

/** The held-call block of the visual contract ("Held call in `secbot chat`"). */
export function heldBlock(call: HeldCall, count: number): string[] {
  const n = call.number;
  const tag = count > 1 ? `[ HELD #${n} of ${count} ]` : `[ HELD #${n} ]`;
  const lines = [
    rightAligned(
      `${tag} ${agentPhrase(call.agent)} wants to run a tool`,
      `lapses in ${timeToLapse(call.remainingMs)}`,
    ),
    `  agent      ${plain(call.agent)}`,
    `  tool       ${plain(call.tool)}`,
  ];
  const args =
    call.arguments !== null && typeof call.arguments === "object" && !Array.isArray(call.arguments)
      ? Object.entries(call.arguments as Record<string, unknown>)
      : [];
  if (args.length === 0) lines.push("  arguments  (none)");
  args.forEach(([key, value], index) => {
    const prefix = index === 0 ? "  arguments  " : " ".repeat(VALUE);
    lines.push(...fill(prefix, words(argumentText(key, value)), VALUE + 2));
  });
  lines.push(...fill("  why held   ", words(call.reason), VALUE));
  lines.push(`  answer     ${answerCell(`/allow ${n}`)}allow once`);
  if (call.always.offered && call.always.rule !== null) {
    lines.push(
      ...fill(
        `${" ".repeat(VALUE)}${answerCell(`/always ${n}`)}`,
        ["allow always; adds:", ...ruleUnits(call.always.rule)],
        ANSWER_TEXT,
      ),
    );
  } else {
    const note = call.always.note ?? "allow always is not offered here";
    lines.push(...fill(" ".repeat(VALUE), words(`(${note})`), VALUE));
  }
  lines.push(`${" ".repeat(VALUE)}${answerCell(`/deny ${n}`)}deny`);
  return lines;
}

/** The reason in the short form of `secbot missed`. */
function shortReason(call: HeldCall): string {
  switch (call.reasonSource) {
    case "your-rule":
      return "your rule: ask first";
    case "owner-rule":
      return "owner rule: ask first";
    case "reviewer-unavailable":
      return "reviewer unavailable";
    case "reviewer":
      return "reviewer";
    default:
      return plain(call.reasonSource);
  }
}

/** The HELD CALLS section of `secbot missed` (contract "`secbot missed` with a held call"). */
export function heldSection(calls: readonly HeldCall[]): string[] {
  const lines = ["HELD CALLS", RULE];
  for (const call of calls) {
    const left = `#${call.number}  ${plain(call.agent)}  ${plain(call.summary)}  ${shortReason(call)}`;
    const right = `lapses in ${timeToLapse(call.remainingMs)}`;
    if (left.length + 2 + right.length <= LINE) lines.push(rightAligned(left, right));
    else lines.push(...fill("", words(left), 4), right.padStart(LINE));
    const answers = [
      `/allow ${call.number}`,
      ...(call.always.offered ? [`/always ${call.number}`] : []),
      `/deny ${call.number}`,
    ];
    lines.push(`answer in secbot chat: ${answers.join(", ")}`);
  }
  return lines;
}

type Answered = {
  number: number;
  status: string;
  answer: AnswerChoice;
  agent: string;
  tool: string;
  summary: string;
  answeredBy: string;
  rule: Rule | null;
};

/** The confirmation lines of the visual contract ("Answer confirmations"). */
export function confirmation(answered: Answered): string[] {
  const head = `#${answered.number} ${plain(answered.summary)}`;
  if (answered.answer === "allow") return [`[ allowed once ] ${head}`];
  if (answered.answer === "always") {
    if (answered.rule === null) return [`[ allowed always ] ${head}`];
    return fill(`[ allowed always ] ${head}; added rule:`, ruleUnits(answered.rule), 2);
  }
  return fill(
    "",
    words(
      `[ denied ] ${head}; ${agentPhrase(answered.agent)} was told "denied by ${answered.answeredBy}"`,
    ),
    2,
  );
}

/** Sends one answer and prints its confirmation, or why it was refused. */
export async function answerHeld(
  client: CellClient,
  io: Io,
  choice: AnswerChoice,
  number: number,
): Promise<void> {
  try {
    const answered = await client.request<Answered>("POST", `/approvals/${number}`, {
      answer: choice,
    });
    io.stdout(`${confirmation(answered).join("\n")}\n`);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const message = error.message;
    if (message === "lapsed") {
      io.stdout(`[ lapsed ] #${number} this request lapsed; nobody answered in 24 h\n`);
    } else if (message === "answered") {
      io.stdout(`#${number} was already answered\n`);
    } else if (message === `no held call #${number}`) {
      io.stdout(`${message}\n`);
    } else if (message.startsWith("refused: allow always is not offered")) {
      const note = message.slice("refused: ".length);
      io.stdout(`${fill("", words(`[ not offered ] #${number} ${note}`), 2).join("\n")}\n`);
    } else {
      io.stderr(`${fill("", words(`secbot: ${message}`), 2).join("\n")}\n`);
    }
  }
}
