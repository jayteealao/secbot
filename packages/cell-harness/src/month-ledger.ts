/**
 * The month ledger view: a person cell's month-to-date spend, read only from pi-durable's own
 * ledger, the `pi.usage` conversation document (installed pi-durable 1.0.3,
 * node_modules/.pnpm/@earendil-works+pi-durable@_39a2d184757a80d838824f8a34b421a0/node_modules/
 * @earendil-works/pi-durable/dist/harness/usage.js:3-23). pi-durable adds every model response
 * (failed attempts included), compaction, and tool result to it; the guard adds its own decision
 * model and reviewer usage under two tool keys (`addGuardUsage`), in the commit that records the
 * guard's verdict. `pi.usage` totals only grow (dist/harness/harness.js:176), so a month is the
 * total less a baseline taken when the month began.
 *
 * A month runs from local midnight on the first, in the household time zone, to the next first.
 * `Intl` gives the zone's offset (`timeZoneName: "longOffset"`); `Temporal` is not in Node 24.14.
 */
import type { Context } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type DocumentReader,
  type Harness,
  ROOT_CONVERSATION_ID,
  type Tx,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import { monthOf } from "./activity.ts";
import { type BudgetName, MonthLedgerDoc, RosterDoc } from "./docs.ts";
import { DEVELOPER_ROLE, GUARD_USAGE_KEYS, LEAD_ROLE } from "./release-defaults.ts";

/** The zone's offset from UTC at `at`, in milliseconds (positive east of Greenwich). */
export function zoneOffsetMs(at: number, zone: string): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const parsed = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (parsed === null) return 0;
  const minutes = Number(parsed[2]) * 60 + Number(parsed[3] ?? 0);
  return (parsed[1] === "-" ? -1 : 1) * minutes * 60_000;
}

/** Local midnight on the first of `month` (1-12) of `year` in `zone`, as epoch milliseconds. */
export function localMonthStart(year: number, month: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, 1);
  // The offset at the wall time is a guess; checked once more at the instant it gives, so a
  // daylight-saving change near the boundary lands on the right side.
  const first = wall - zoneOffsetMs(wall, zone);
  return wall - zoneOffsetMs(first, zone);
}

export interface MonthBounds {
  /** `YYYY-MM` in the zone. */
  readonly month: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

/** The month that holds `at` in `zone`: its key and its local-midnight bounds. */
export function monthBounds(at: number, zone: string): MonthBounds {
  const month = monthOf(at, zone);
  const [year = 1970, number = 1] = month.split("-").map(Number);
  const next = number === 12 ? { year: year + 1, number: 1 } : { year, number: number + 1 };
  return {
    month,
    startsAt: localMonthStart(year, number, zone),
    endsAt: localMonthStart(next.year, next.number, zone),
  };
}

/** The local hour (`0`-`23`) of `at` in `zone`. */
export function hourOf(at: number, zone: string): string {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return String(Number(hour));
}

/** One conversation of the cell and the role it belongs to. */
export interface LedgerConversation {
  readonly id: ConversationId;
  /** The id as a document key. */
  readonly conversationId: string;
  readonly role: string;
}

/** The lead's conversation and each specialist's, from the roster. */
export async function ledgerConversations(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<LedgerConversation[]> {
  const roster = await reader.snapshot(RosterDoc, context);
  return [
    { id: ROOT_CONVERSATION_ID, conversationId: String(ROOT_CONVERSATION_ID), role: LEAD_ROLE },
    ...Object.entries(roster?.specialists ?? {}).map(([role, record]) => ({
      id: record.conversationId,
      conversationId: String(record.conversationId),
      role,
    })),
  ];
}

/** Which budget a role's spend counts against. */
export const budgetOf = (role: string): BudgetName =>
  role === DEVELOPER_ROLE ? "developer" : "person";

export type Layer = "agent" | "decision" | "reviewer";

export interface LayerSpend {
  agent: number;
  decision: number;
  reviewer: number;
}

const GUARD_KEYS: Readonly<Record<string, Layer>> = {
  [GUARD_USAGE_KEYS.decision]: "decision",
  [GUARD_USAGE_KEYS.reviewer]: "reviewer",
};

/** Every bucket key's cost (`m:<model>`, `t:<tool>`) of one conversation's ledger. */
export function costsOf(state: Readonly<UsageState> | undefined): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const [key, usage] of Object.entries(state?.models ?? {})) {
    costs[`m:${key}`] = usage.cost.total;
  }
  for (const [key, usage] of Object.entries(state?.tools ?? {})) {
    costs[`t:${key}`] = usage.cost.total;
  }
  return costs;
}

/**
 * One conversation's spend since the baseline, by layer. A key with no baseline counts whole; a
 * key below its baseline (a snapshot restored from before the month began) counts as zero.
 */
export function spendSince(
  costs: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>> | undefined,
): LayerSpend {
  const spend: LayerSpend = { agent: 0, decision: 0, reviewer: 0 };
  for (const [key, cost] of Object.entries(costs)) {
    const before =
      baseline !== undefined && Object.hasOwn(baseline, key) ? (baseline[key] ?? 0) : 0;
    const delta = Math.max(0, cost - before);
    const layer = key.startsWith("t:") ? (GUARD_KEYS[key.slice(2)] ?? "agent") : "agent";
    spend[layer] += delta;
  }
  return spend;
}

const total = (spend: LayerSpend) => spend.agent + spend.decision + spend.reviewer;

/** The month-to-date spend of one cell, split by budget, layer, and role. */
export interface MonthSpend {
  readonly month: string;
  readonly zone: string;
  readonly startsAt: number;
  /** When the month resets: local midnight on the next first. */
  readonly resetsAt: number;
  readonly person: {
    readonly spentUsd: number;
    readonly byLayer: LayerSpend;
    readonly byRole: Readonly<Record<string, number>>;
  };
  /** This cell's own developer spend (the household budget adds the other cells'). */
  readonly developer: { readonly spentUsd: number; readonly byLayer: LayerSpend };
  /** Spend by local hour (`0`-`23`) and role, from the hour chart. */
  readonly hours: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

type Ledger = {
  month: string;
  zone: string;
  startsAt: number;
  endsAt: number;
  nextZone: string | null;
  baseline: Record<string, Record<string, number>>;
  hours: Record<string, Record<string, number>>;
  seen: Record<string, number>;
};

const sum = (costs: Readonly<Record<string, number>>) =>
  Object.values(costs).reduce((all, cost) => all + cost, 0);

/** One conversation's ledger total, in USD: every model and tool bucket, guard calls included. */
export const conversationTotal = (state: Readonly<UsageState> | undefined): number =>
  sum(costsOf(state));

/**
 * The current month's ledger, rolled in one commit when `now` passed its end (or started at the
 * first read). A roll keeps the closing month's person spend in `closed`, takes every
 * conversation's totals as the new baseline, and applies a time zone the owner set during the
 * closing month. The first month of a cell has no baseline: what its conversations spent before
 * counts in it.
 */
export async function ensureMonth(
  harness: Harness,
  now: number,
  zone: string,
  conversations: readonly LedgerConversation[],
  context: Context,
): Promise<{ readonly ledger: Readonly<Ledger>; readonly rolled: boolean }> {
  const current = await harness.snapshot(MonthLedgerDoc, context);
  if (current !== undefined && current.month !== "" && now < current.endsAt) {
    return { ledger: current as Ledger, rolled: false };
  }
  return harness.commit(async (tx) => {
    const doc = await tx.doc(MonthLedgerDoc);
    if (doc.month !== "" && now < doc.endsAt) {
      return { ledger: JSON.parse(JSON.stringify(doc)) as Ledger, rolled: false };
    }
    const first = doc.month === "";
    const nextZone = first ? zone : (doc.nextZone ?? doc.zone);
    const bounds = monthBounds(now, nextZone);
    const baseline: Record<string, Record<string, number>> = {};
    const seen: Record<string, number> = {};
    let closing = 0;
    for (const { id, conversationId, role } of conversations) {
      const costs = costsOf(await tx.doc(UsageDoc, id));
      if (!first && budgetOf(role) === "person") {
        closing += total(spendSince(costs, doc.baseline[conversationId]));
      }
      if (!first) baseline[conversationId] = costs;
      seen[conversationId] = sum(costs);
    }
    if (!first) doc.closed = { ...doc.closed, [doc.month]: Math.round(closing * 10_000) / 10_000 };
    Object.assign(doc, {
      month: bounds.month,
      zone: nextZone,
      startsAt: bounds.startsAt,
      endsAt: bounds.endsAt,
      nextZone: null,
      baseline,
      hours: {},
      seen,
    });
    return { ledger: JSON.parse(JSON.stringify(doc)) as Ledger, rolled: true };
  }, context);
}

/** The month-to-date spend from the ledger (rolling the month first when it ended). */
export async function readMonth(
  harness: Harness,
  now: number,
  zone: string,
  context: Context,
): Promise<MonthSpend & { readonly rolled: boolean }> {
  const conversations = await ledgerConversations(harness, context);
  const { ledger, rolled } = await ensureMonth(harness, now, zone, conversations, context);
  const person: LayerSpend = { agent: 0, decision: 0, reviewer: 0 };
  const developer: LayerSpend = { agent: 0, decision: 0, reviewer: 0 };
  const byRole: Record<string, number> = {};
  for (const { id, conversationId, role } of conversations) {
    const state = await harness.snapshot(UsageDoc, id, context);
    const spend = spendSince(costsOf(state), ledger.baseline[conversationId]);
    const into = budgetOf(role) === "developer" ? developer : person;
    into.agent += spend.agent;
    into.decision += spend.decision;
    into.reviewer += spend.reviewer;
    if (budgetOf(role) === "person") byRole[role] = (byRole[role] ?? 0) + total(spend);
  }
  return {
    month: ledger.month,
    zone: ledger.zone,
    startsAt: ledger.startsAt,
    resetsAt: ledger.endsAt,
    person: { spentUsd: total(person), byLayer: person, byRole },
    developer: { spentUsd: total(developer), byLayer: developer },
    hours: ledger.hours,
    rolled,
  };
}

/**
 * Adds each conversation's spend since the hour chart last looked to the local hour of `now`, by
 * role, in `tx`. Returns the total it added.
 */
export async function noteHours(
  tx: Tx,
  conversations: readonly LedgerConversation[],
  now: number,
): Promise<number> {
  const ledger = await tx.doc(MonthLedgerDoc);
  if (ledger.month === "") return 0;
  const hour = hourOf(now, ledger.zone);
  let added = 0;
  for (const { id, conversationId, role } of conversations) {
    const spent = sum(costsOf(await tx.doc(UsageDoc, id)));
    const before = Object.hasOwn(ledger.seen, conversationId)
      ? (ledger.seen[conversationId] ?? 0)
      : 0;
    ledger.seen[conversationId] = spent;
    const delta = spent - before;
    if (delta <= 0) continue;
    ledger.hours[hour] ??= {};
    const roles = ledger.hours[hour];
    roles[role] = (roles[role] ?? 0) + delta;
    added += delta;
  }
  return added;
}

/** A usage with no tokens and this cost, for a guard model call that reported a cost only. */
export function costOnlyUsage(costUsd: number): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
  };
}

/** `usage` as strict JSON: optional counters that a provider left undefined are dropped. */
function plainUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    cost: { ...usage.cost },
  };
}

/**
 * Adds one guard model call's usage to the calling conversation's `pi.usage`, under the decision
 * model's or the reviewer's tool key, in the guard's own commit. The counters are pi-durable's own
 * (`addUsage`, dist/harness/usage.js:24-39), which the package does not export
 * (package.json `exports`: `.`, `./env`, `./env/node`, `./tools`, `./storage/*`, `./testing`).
 */
export async function addGuardUsage(
  tx: Tx,
  conversationId: ConversationId,
  layer: Exclude<Layer, "agent">,
  usage: Usage,
): Promise<void> {
  const tools = (await tx.doc(UsageDoc, conversationId)).tools as Record<string, Usage>;
  const key = GUARD_USAGE_KEYS[layer];
  const known = Object.hasOwn(tools, key) ? tools[key] : undefined;
  if (known === undefined) {
    tools[key] = plainUsage(usage);
    return;
  }
  known.input += usage.input;
  known.output += usage.output;
  known.cacheRead += usage.cacheRead;
  known.cacheWrite += usage.cacheWrite;
  known.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) {
    known.cacheWrite1h = (known.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) known.reasoning = (known.reasoning ?? 0) + usage.reasoning;
  known.cost.input += usage.cost.input;
  known.cost.output += usage.cost.output;
  known.cost.cacheRead += usage.cost.cacheRead;
  known.cost.cacheWrite += usage.cost.cacheWrite;
  known.cost.total += usage.cost.total;
}
