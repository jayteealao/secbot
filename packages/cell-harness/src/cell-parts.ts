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

/** One structured log line (celld captures console output as worker logs). */
export function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
