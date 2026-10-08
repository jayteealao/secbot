/**
 * The cell's own session documents, committed with the transcript (pi-durable `defineDoc`,
 * scope "session": one per harness, which is one per person cell).
 */
import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type EntryId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ActivityRecord } from "./activity.ts";
import type { Rule } from "./rules.ts";

export type SpecialistRecord = {
  conversationId: ConversationId;
  instruction: string;
  /** The background anchor task that owns the specialist's conversation. */
  anchorTaskId: TaskId;
  builtIn: boolean;
  /** Answers already reported to the lead, so a restart reports each once. */
  reported: EntryId[];
};

/** `secbot.specialists`: the roster, keyed by specialist name. */
export const RosterDoc = defineDoc<{
  specialists: Record<string, SpecialistRecord>;
  /** Hand-off reporter tasks, keyed by the handoff tool task that created them. */
  reporters: Record<string, TaskId>;
}>({
  kind: "secbot.specialists",
  version: 1,
  scope: "session",
  initial: () => ({ specialists: {}, reporters: {} }),
});

/** `secbot.role-models`: the owner's changes to the role-to-model map; release defaults fill the rest. */
export const RoleModelsDoc = defineDoc<{ overrides: Record<string, string> }>({
  kind: "secbot.role-models",
  version: 1,
  scope: "session",
  initial: () => ({ overrides: {} }),
});

export type ModelHealthState = "ok" | "failing" | "credit";

/** `secbot.model-health`: whether model calls are failing, since when, and whether the owner was told. */
export const ModelHealthDoc = defineDoc<{
  state: ModelHealthState;
  since: number | null;
  lastError: string;
  alertedAt: number | null;
  /** Which alert `alertedAt` claimed; absent in documents written before it existed. */
  alertedKind?: "outage" | "credit" | null;
  /** When that alert was sent; null while the send is pending (a crash then leaves it unsent). */
  sentAt?: number | null;
  /** Sessions show "waiting for the model" while this is true. */
  waiting: boolean;
}>({
  kind: "secbot.model-health",
  version: 1,
  scope: "session",
  initial: () => ({ state: "ok", since: null, lastError: "", alertedAt: null, waiting: false }),
});

/** `secbot.delivery`: per device, the newest lead message a session or `missed` delivered. */
export const DeliveryDoc = defineDoc<{ devices: Record<string, EntryId> }>({
  kind: "secbot.delivery",
  version: 1,
  scope: "session",
  initial: () => ({ devices: {} }),
});

/**
 * `secbot.rules`: the owner's rules and the person's rules for this person's agents. Seeded once
 * with the release owner rule and the four default person rules (`seeded`).
 */
export const RulesDoc = defineDoc<{
  seeded: boolean;
  nextId: number;
  owner: Rule[];
  person: Rule[];
}>({
  kind: "secbot.rules",
  version: 1,
  scope: "session",
  initial: () => ({ seeded: false, nextId: 1, owner: [], person: [] }),
});

/**
 * `secbot.activity`: per month (`YYYY-MM` in the cell's time zone) the number of pages and
 * records, and the keys of the newest records, so a guard that runs again after a crash finds
 * its record and writes no second one.
 */
export const ActivityDoc = defineDoc<{
  months: Record<string, { pages: number; total: number }>;
  recent: string[];
}>({
  kind: "secbot.activity",
  version: 1,
  scope: "session",
  initial: () => ({ months: {}, recent: [] }),
});

/** `secbot.activity-page`: up to ACTIVITY_PAGE_SIZE records, keyed `YYYY-MM:<page>` (from 1). */
export const ActivityPageDoc = defineDocFamily<{ records: ActivityRecord[] }, null>({
  kind: "secbot.activity-page",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ records: [] }),
});
