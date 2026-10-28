/**
 * The loop guard's reading of a job's request: how many failing steps in a row end the messages,
 * and how much the next step may cost. Both are pure functions of the request's messages, so no
 * counter can drift after a crash between a step and its commit: the messages are the durable
 * record.
 *
 * A failing step (D-028) is a tool call that errors with the same tool and near-same arguments as
 * the failing call before it, or an empty or cut-off model reply. A provider failure (an assistant
 * message with stop reason `error` or `aborted`: a 429, a 402, an outage) is skipped and never
 * counted: the job waits for the provider instead.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { EMPTY_REPLY_NUDGE, NEAR_SAME_MAX_DISTANCE } from "./release-defaults.ts";

/** One tool call: its name and its arguments. */
export interface CallShape {
  readonly name: string;
  readonly args: unknown;
}

const fold = (value: unknown): unknown => {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return value.map(fold);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, fold((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/** Arguments as one comparable text: keys sorted, strings trimmed, whitespace folded, lower case. */
export function normalizeArgs(args: unknown): string {
  return JSON.stringify(fold(args)) ?? "";
}

/**
 * True when the edit distance of `a` and `b` is at most `limit` (a banded Levenshtein: only cells
 * within `limit` of the diagonal are computed, so a long argument costs O(length × limit)).
 */
function withinDistance(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  if (limit === 0) return a === b;
  const big = limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => (j <= limit ? j : big));
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(big);
    if (i <= limit) current[0] = i;
    let best = current[0] as number;
    const from = Math.max(1, i - limit);
    const to = Math.min(b.length, i + limit);
    for (let j = from; j <= to; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j - 1] as number) + cost,
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
      );
      current[j] = Math.min(value, big);
      best = Math.min(best, current[j] as number);
    }
    if (best > limit) return false;
    previous = current;
  }
  return (previous[b.length] as number) <= limit;
}

/**
 * Two calls are near-same when they name the same tool and their normalized arguments are equal or
 * differ by at most `NEAR_SAME_MAX_DISTANCE` of the longer text: a re-phrased long query counts, a
 * different short argument (another list, another date in a ten-letter query) does not.
 */
export function nearSame(a: CallShape, b: CallShape): boolean {
  if (a.name !== b.name) return false;
  const left = normalizeArgs(a.args);
  const right = normalizeArgs(b.args);
  if (left === right) return true;
  const limit = Math.floor(NEAR_SAME_MAX_DISTANCE * Math.max(left.length, right.length));
  return withinDistance(left, right, limit);
}

type Failure = { readonly kind: "empty" } | { readonly kind: "tool"; readonly call: CallShape };

const textOf = (message: AssistantMessage): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

const userText = (message: Message): string => {
  if (message.role !== "user") return "";
  const { content } = message;
  return typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

/** The failing steps at the end of the messages, newest first, up to the first other step. */
function trailingFailures(messages: readonly Message[]): Failure[] {
  const calls = new Map<string, CallShape>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall") calls.set(part.id, { name: part.name, args: part.arguments });
    }
  }
  const failures: Failure[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Message;
    if (message.role === "toolResult") {
      if (message.isError !== true) break;
      failures.push({
        kind: "tool",
        call: calls.get(message.toolCallId) ?? { name: message.toolName, args: null },
      });
    } else if (message.role === "assistant") {
      // A provider failure is a wait, never a failing step.
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const calling = message.content.some((part) => part.type === "toolCall");
      if (message.stopReason === "length" || (!calling && textOf(message).trim() === "")) {
        failures.push({ kind: "empty" });
      } else if (!calling) {
        break;
      }
      // A message that calls tools is judged by its results.
    } else if (message.role === "user") {
      if (userText(message) !== EMPTY_REPLY_NUDGE) break;
    }
  }
  return failures;
}

/**
 * How many failing steps in a row end the messages: tool errors each near-same to the failing call
 * after it, or empty and cut-off replies. A different kind of failure ends the run.
 */
export function failingStreak(messages: readonly Message[]): number {
  const failures = trailingFailures(messages);
  const first = failures[0];
  if (first === undefined) return 0;
  let streak = 1;
  for (let i = 1; i < failures.length; i++) {
    const newer = failures[i - 1] as Failure;
    const older = failures[i] as Failure;
    if (older.kind !== newer.kind) break;
    if (older.kind === "tool" && newer.kind === "tool" && !nearSame(older.call, newer.call)) break;
    streak++;
  }
  return streak;
}

/**
 * The next step's projected cost: the largest single step so far in the messages (0 when none).
 * A step's cost is known only after it, so the largest seen is the gate's estimate.
 */
export function projectNext(messages: readonly Message[]): number {
  let largest = 0;
  for (const message of messages) {
    if (message.role === "assistant") largest = Math.max(largest, message.usage?.cost?.total ?? 0);
  }
  return largest;
}
