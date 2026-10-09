import type { Models } from "@earendil-works/pi-ai";
import type { Conversation, Extension, Harness } from "@earendil-works/pi-durable";

/** What the roster, the model map, and the routes share about one open person cell. */
export interface CellParts {
  readonly person: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly models: Models;
  /** The extensions each role selects, in order. */
  readonly extensions: {
    readonly lead: readonly Extension[];
    readonly specialist: readonly Extension[];
  };
}

/** A change the cell refuses; the message is safe to show the owner. */
export class RefusedChange extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedChange";
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One structured log line (celld captures console output as worker logs). Every line carries a
 * `level` field, so an operator can filter failures and refusals; warn and error lines also go to
 * the console's warn and error streams.
 */
export function logEvent(
  event: string,
  fields: Record<string, unknown>,
  level: LogLevel = "info",
): void {
  const line = JSON.stringify({ event, level, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  for (const listener of listeners) {
    try {
      listener(event, fields);
    } catch {
      // A listener never changes what the cell does.
    }
  }
}

export type LogListener = (event: string, fields: Readonly<Record<string, unknown>>) => void;
const listeners = new Set<LogListener>();

/**
 * Observes every event this process logs, as fields (the test cell's guard bench reads its
 * `guard.verdict` events this way instead of parsing log text). Returns the function that stops it.
 */
export function onLogEvent(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A provider or runtime error reduced to what is safe to log or store: the leading HTTP status
 * and the provider's error code when the text has them, otherwise the short text before any JSON
 * body. Request text that a provider echoes back (for example a moderation excerpt in `metadata`)
 * is dropped.
 */
export function safeErrorText(text: string): string {
  const status = /^\s*(\d{3})\b/.exec(text)?.[1];
  const code = /"code"\s*:\s*"?([A-Za-z0-9_.-]{1,40})"?/.exec(text)?.[1];
  if (status !== undefined) {
    return code !== undefined && code !== status ? `${status} code=${code}` : status;
  }
  const head = (text.split(/[{\n]/)[0] ?? "").trim().slice(0, 120);
  return head === "" ? "error" : head;
}

/** Log fields for a caught error: its class name and a safe, short message. */
export function errorFields(error: unknown): { error_name: string; error: string } {
  if (error instanceof Error) {
    return { error_name: error.name, error: safeErrorText(error.message) };
  }
  return { error_name: typeof error, error: safeErrorText(String(error)) };
}
