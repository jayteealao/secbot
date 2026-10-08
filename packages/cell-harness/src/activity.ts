/**
 * The activity log: one durable record per guard verdict, kept forever (no pruning), in month
 * pages of a document family. An append is one small document change; a month lists without
 * reading older months; snapshots and restores carry the pages like every other document.
 *
 * Later work adds record kinds (held, answered, lapsed, job) and fields (cost, mode) to the same
 * record shape without a migration.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { DocumentReader, Tx } from "@earendil-works/pi-durable";
import { ActivityDoc, ActivityPageDoc } from "./docs.ts";
import { ARGUMENTS_LIMIT, redact, redactText } from "./redact.ts";

export const ACTIVITY_PAGE_SIZE = 200;
/** How many of the newest record keys the rerun check remembers. */
export const RECENT_KEYS = 64;

export type ActivityVerdict = "allowed" | "refused";
export type ActivityLayer = "rule" | "guard";

export type ActivityRecord = {
  /** `<task id>:<call id>`: the same on a rerun of the same call. */
  key: string;
  at: number;
  kind: "verdict";
  /** The calling role: lead, a specialist name, or "other". */
  agent: string;
  tool: string;
  verdict: ActivityVerdict;
  layer: ActivityLayer;
  reason: string;
  ruleId: number | null;
  ruleLevel: "owner" | "person" | null;
  /** The call's arguments after redaction, capped at ARGUMENTS_LIMIT bytes. */
  arguments: JsonValue;
  cost: number;
};

/** `YYYY-MM` of `at` in `timeZone`. */
export function monthOf(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A record ready to store: reason and arguments redacted, the matched fields kept whole. */
export function recordOf(
  fields: Omit<ActivityRecord, "arguments" | "reason"> & {
    readonly arguments: Readonly<Record<string, JsonValue>>;
    readonly reason: string;
    readonly keep: readonly string[];
    readonly values?: readonly string[];
  },
): ActivityRecord {
  const { keep, values = [], ...rest } = fields;
  return {
    ...rest,
    reason: redactText(fields.reason, values),
    arguments: redact({ ...fields.arguments }, { keep, values, maxBytes: ARGUMENTS_LIMIT }),
  };
}

/**
 * Appends a record to its month's last page, opening a new page at ACTIVITY_PAGE_SIZE records.
 * Returns false and writes nothing when a record with the same key is among the newest ones.
 */
export async function appendRecord(
  tx: Tx,
  record: ActivityRecord,
  timeZone: string,
): Promise<boolean> {
  const activity = await tx.doc(ActivityDoc);
  if (activity.recent.includes(record.key)) return false;
  const month = monthOf(record.at, timeZone);
  const counts = activity.months[month] ?? { pages: 1, total: 0 };
  let page = await tx.doc(ActivityPageDoc, `${month}:${counts.pages}`, null);
  if (page.records.length >= ACTIVITY_PAGE_SIZE) {
    counts.pages += 1;
    page = await tx.doc(ActivityPageDoc, `${month}:${counts.pages}`, null);
  }
  page.records.push(record);
  counts.total += 1;
  activity.months[month] = counts;
  activity.recent.push(record.key);
  if (activity.recent.length > RECENT_KEYS)
    activity.recent.splice(0, activity.recent.length - RECENT_KEYS);
  return true;
}

export interface ActivityQuery {
  /** `YYYY-MM`; the current month in the cell's time zone when absent. */
  readonly month?: string;
  /** Only records numbered below this (the `next` of an earlier page). */
  readonly before?: number;
  /** 1-200, default 50. */
  readonly limit?: number;
}

export interface ActivityPage {
  readonly month: string;
  readonly timeZone: string;
  /** Every record of the month. */
  readonly total: number;
  /** Newest first. */
  readonly records: readonly ActivityRecord[];
  /** The `before` for the next older page, or null when none is left. */
  readonly next: number | null;
}

/** A month's records, newest first. Each record's number is its place in the month, from 0. */
export async function listActivity(
  reader: DocumentReader,
  query: ActivityQuery & { readonly now: number; readonly timeZone: string },
  context: Context,
): Promise<ActivityPage> {
  const month = query.month ?? monthOf(query.now, query.timeZone);
  const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
  const counts = (await reader.snapshot(ActivityDoc, context))?.months[month];
  const total = counts?.total ?? 0;
  const end = Math.min(total, Math.max(0, Math.floor(query.before ?? total)));
  const start = Math.max(0, end - limit);
  const records: ActivityRecord[] = [];
  const firstPage = Math.floor(start / ACTIVITY_PAGE_SIZE) + 1;
  const lastPage = Math.floor((end - 1) / ACTIVITY_PAGE_SIZE) + 1;
  for (let number = lastPage; end > 0 && number >= firstPage; number--) {
    const page = await reader.snapshot(ActivityPageDoc, `${month}:${number}`, context);
    const offset = (number - 1) * ACTIVITY_PAGE_SIZE;
    const items = page?.records ?? [];
    for (let index = items.length - 1; index >= 0; index--) {
      const position = offset + index;
      const item = items[index];
      if (position >= start && position < end && item !== undefined) records.push(item);
    }
  }
  return {
    month,
    timeZone: query.timeZone,
    total,
    records,
    next: start > 0 ? start : null,
  };
}
