/**
 * Held calls: an ask-first call waits for the person, who answers allow once, allow always, or
 * deny; with no answer in 24 hours the call lapses as a refusal.
 *
 * The record before the wait. The guard commits, in one transaction, the held-call record, its
 * request-id lookup, its number in the pending list, and one `held` activity record, and only then
 * waits. A `beforeTool` hook waiting at a crash runs again from the start after the restart, with
 * the same task and call ids (test/crash.test.ts), so the hook's first act on every call is a
 * lookup by request id: a rerun finds the record and waits on it again; it never makes a second
 * record, a second number, or a second prompt.
 *
 * Binding. A record binds a request id and a SHA-256 digest of the normalized arguments. The same
 * request id with other arguments is a new held call. Consuming an allowed record is one commit
 * that names the consuming call, so two calls cannot share one allow-once answer, and a crash
 * between the consume and the run is recognised by the same call key.
 *
 * Every answer and every lapse is one commit that changes the record's status, writes one activity
 * record, and leaves the pending list; the events (`approval.held`, `approval.answered`,
 * `approval.lapsed`) carry no argument values. Expiry uses the cell's clock only.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { DocumentReader, Harness, Tx } from "@earendil-works/pi-durable";
import { type ActivityLayer, appendRecord, recordOf } from "./activity.ts";
import { logEvent } from "./cell-parts.ts";
import { ApprovalDoc, ApprovalKeyDoc, ApprovalsDoc } from "./docs.ts";
import { ARGUMENTS_LIMIT, redact } from "./redact.ts";
import { ALWAYS_KEY_FIELD } from "./release-defaults.ts";
import { addAllowAlways, allowAlwaysAdded } from "./rule-store.ts";
import {
  ALL_AGENTS,
  decide,
  looserThan,
  normalizeMatchValue,
  normalizeText,
  type Rule,
  type RuleCall,
  type RuleInput,
} from "./rules.ts";

export type ReasonSource = "your-rule" | "owner-rule" | "reviewer" | "reviewer-unavailable";
export type HeldStatus = "pending" | "allowed" | "always" | "denied" | "lapsed";
export type AnswerChoice = "allow" | "always" | "deny";
export type LapseCause = "expired" | "aborted";

/** Whether allow always is offered, the rule it would add, and, when not, the one line why. */
export type AlwaysOffer = { offered: boolean; rule: RuleInput | null; note: string | null };

/** The durable record of one held call. */
export type HeldCall = {
  number: number;
  requestId: string;
  /** `<task id>:<call id>` of the call that was held. */
  callKey: string;
  /** SHA-256 hex of the canonical normalized arguments; the arguments themselves are not kept. */
  digest: string;
  conversationId: string;
  agent: string;
  tool: string;
  /** `handoff -> research`, or the tool name. */
  summary: string;
  /** The arguments after redaction, for display. */
  arguments: JsonValue;
  /** The argument fields the holding rule matched, kept whole on display. */
  matched: string[];
  reason: string;
  reasonSource: ReasonSource;
  ruleId: number | null;
  ruleLevel: "owner" | "person" | null;
  always: AlwaysOffer;
  heldAt: number;
  expiresAt: number;
  status: HeldStatus;
  answeredAt: number | null;
  /** The person who answered. */
  answeredBy: string | null;
  /** The device that answered. */
  device: string | null;
  /** The call key that consumed an allowed record. */
  consumedBy: string | null;
  lapseCause: LapseCause | null;
};

/** What routes, frames, and the command line show of a held call. */
export interface HeldCallView {
  readonly number: number;
  readonly requestId: string;
  readonly agent: string;
  readonly tool: string;
  readonly summary: string;
  readonly arguments: JsonValue;
  readonly reason: string;
  readonly reasonSource: ReasonSource;
  readonly always: AlwaysOffer;
  readonly heldAt: number;
  readonly expiresAt: number;
  /** Milliseconds left before the call lapses, by the cell's clock when this view was made. */
  readonly remainingMs: number;
  readonly status: HeldStatus;
}

/** The refusal an agent gets, and the line a late answer prints, when a held call lapsed. */
export const LAPSED_TEXT = "this request lapsed; nobody answered in 24 h";
/** The refusal for a second call under an allow-once answer that another call already used. */
export const USED_TEXT = "this approval was already used";
export const NOT_OFFERED_OWNER = "allow always is not offered: an owner rule asks first here";
export const NOT_OFFERED_PERSON =
  "allow always is not offered: your rule for this exact match asks first";
export const NOT_OFFERED_AGENT = "allow always is not offered for this agent";

/** No held call has this number. */
export class NoHeldCall extends Error {
  constructor(readonly number: number) {
    super(`no held call #${number}`);
    this.name = "NoHeldCall";
  }
}

/** The held call lapsed before this answer. */
export class HeldCallLapsed extends Error {
  constructor(readonly number: number) {
    super(LAPSED_TEXT);
    this.name = "HeldCallLapsed";
  }
}

/** The held call was already answered. */
export class HeldCallAnswered extends Error {
  constructor(readonly number: number) {
    super(`#${number} was already answered`);
    this.name = "HeldCallAnswered";
  }
}

/** Allow always was not offered for this held call. */
export class AlwaysNotOffered extends Error {
  constructor(
    readonly number: number,
    note: string,
  ) {
    super(note);
    this.name = "AlwaysNotOffered";
  }
}

/** Schedules `fire` after `ms`; returns a cancel function. Tests pass a controlled clock. */
export type SetTimer = (ms: number, fire: () => void) => () => void;

/** The longest delay setTimeout takes; a longer wait fires early and is checked against the clock. */
const MAX_TIMER_MS = 2_147_483_647;

export const defaultSetTimer: SetTimer = (ms, fire) => {
  const timer = setTimeout(fire, Math.min(Math.max(0, ms), MAX_TIMER_MS)) as unknown as {
    unref?: () => void;
  };
  timer.unref?.();
  return () => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
};

/** The person cell an approval belongs to: its harness, name, and time zone. */
export interface ApprovalParts {
  readonly harness: Harness;
  readonly person: string;
  readonly timeZone: string;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Canonical JSON: object keys sorted, every string through normalizeText. */
function canonical(value: JsonValue): JsonValue {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key] as JsonValue);
    return sorted;
  }
  return value;
}

/** SHA-256 hex of the canonical normalized arguments (Web Crypto, built in). */
export async function argumentDigest(args: Readonly<Record<string, JsonValue>>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ ...args })));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `handoff -> research` for a hand-off, otherwise the tool name. */
export function summaryOf(tool: string, args: Readonly<Record<string, JsonValue>>): string {
  const specialist = args.specialist;
  return tool === "handoff" && typeof specialist === "string" && specialist !== ""
    ? `handoff -> ${specialist}`
    : tool;
}

/**
 * The allow-always offer for a held call: a person permit rule for the agent, the tool, and an
 * exact match on the field the holding rule matched (or the tool's key field). Offered only when
 * the rules with that candidate added decide permit, so an owner ask-first rule, or the person's
 * own ask-first rule on the same exact match, means it is not offered.
 */
export function alwaysOffer(
  rules: { readonly owner: readonly Rule[]; readonly person: readonly Rule[] },
  call: RuleCall,
  matched: readonly string[],
  agents: ReadonlySet<string>,
): AlwaysOffer {
  if (call.role === ALL_AGENTS || !agents.has(call.role)) {
    return { offered: false, rule: null, note: NOT_OFFERED_AGENT };
  }
  const field = matched[0] ?? ALWAYS_KEY_FIELD[call.tool];
  const raw = field === undefined ? undefined : call.arguments[field];
  const value =
    typeof raw === "string" && raw.trim() !== "" && raw.length <= 500
      ? normalizeMatchValue("exact", raw)
      : undefined;
  const rule: RuleInput =
    field !== undefined && value !== undefined && value !== ""
      ? {
          agent: call.role,
          tool: call.tool,
          verdict: "permit",
          match: { kind: "exact", field, value },
        }
      : { agent: call.role, tool: call.tool, verdict: "permit" };
  const candidate: Rule = { ...rule, id: -1, source: "allow-always", addedAt: 0 };
  const decided = decide(rules.owner, [...rules.person, candidate], call);
  if (decided.verdict === "permit" && looserThan(rule, rules.owner) === undefined) {
    return { offered: true, rule, note: null };
  }
  const owner = decide(rules.owner, [], call).verdict;
  const note = owner !== undefined && owner !== "permit" ? NOT_OFFERED_OWNER : NOT_OFFERED_PERSON;
  return { offered: false, rule: null, note };
}

export interface HoldInput {
  readonly requestId: string;
  readonly callKey: string;
  readonly digest: string;
  readonly conversationId: string;
  readonly agent: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly matched: readonly string[];
  readonly reason: string;
  readonly reasonSource: ReasonSource;
  readonly layer: ActivityLayer;
  readonly ruleId: number | null;
  readonly ruleLevel: "owner" | "person" | null;
  readonly always: AlwaysOffer;
  readonly heldAt: number;
  readonly expiresAt: number;
}

/**
 * Holds a call: the next number, the record, the request-id lookup, the pending number, and one
 * `held` activity record, all in the caller's transaction. Returns a plain copy of the record.
 */
export async function holdCall(tx: Tx, input: HoldInput, timeZone: string): Promise<HeldCall> {
  const approvals = await tx.doc(ApprovalsDoc);
  const number = approvals.nextNumber++;
  const shown = redact(
    { ...input.arguments },
    { keep: input.matched, maxBytes: ARGUMENTS_LIMIT },
  ) as JsonValue;
  const call: HeldCall = {
    number,
    requestId: input.requestId,
    callKey: input.callKey,
    digest: input.digest,
    conversationId: input.conversationId,
    agent: input.agent,
    tool: input.tool,
    summary: summaryOf(input.tool, input.arguments),
    arguments: shown,
    matched: [...input.matched],
    reason: input.reason,
    reasonSource: input.reasonSource,
    ruleId: input.ruleId,
    ruleLevel: input.ruleLevel,
    always: copy(input.always),
    heldAt: input.heldAt,
    expiresAt: input.expiresAt,
    status: "pending",
    answeredAt: null,
    answeredBy: null,
    device: null,
    consumedBy: null,
    lapseCause: null,
  };
  (await tx.doc(ApprovalDoc, String(number), null)).call = call;
  (await tx.doc(ApprovalKeyDoc, input.requestId, null)).numbers.push(number);
  approvals.pending.push(number);
  await appendRecord(
    tx,
    recordOf({
      key: input.callKey,
      at: input.heldAt,
      kind: "held",
      number,
      agent: input.agent,
      tool: input.tool,
      verdict: "held",
      layer: input.layer,
      reason: input.reason,
      ruleId: input.ruleId,
      ruleLevel: input.ruleLevel,
      arguments: input.arguments,
      keep: input.matched,
      cost: 0,
    }),
    timeZone,
  );
  return copy(call);
}

/** The newest held call of this request id whose arguments have this digest. */
export async function findHeld(
  reader: DocumentReader,
  requestId: string,
  digest: string,
  context: Context,
): Promise<HeldCall | undefined> {
  const key = await reader.snapshot(ApprovalKeyDoc, requestId, context);
  for (const number of [...(key?.numbers ?? [])].reverse()) {
    const found = (await reader.snapshot(ApprovalDoc, String(number), context))?.call;
    if (found?.digest === digest) return copy(found);
  }
  return undefined;
}

/** The held call with this number, or undefined. */
export async function readHeld(
  reader: DocumentReader,
  number: number,
  context: Context,
): Promise<HeldCall | undefined> {
  const found = (await reader.snapshot(ApprovalDoc, String(number), context))?.call;
  return found === null || found === undefined ? undefined : copy(found);
}

export function viewOf(call: HeldCall, now: number): HeldCallView {
  return {
    number: call.number,
    requestId: call.requestId,
    agent: call.agent,
    tool: call.tool,
    summary: call.summary,
    arguments: call.arguments,
    reason: call.reason,
    reasonSource: call.reasonSource,
    always: call.always,
    heldAt: call.heldAt,
    expiresAt: call.expiresAt,
    remainingMs: Math.max(0, call.expiresAt - now),
    status: call.status,
  };
}

const LAPSE_REASON: Record<LapseCause, string> = {
  expired: "no answer in 24 h; refused",
  aborted: "the agent's job was aborted; refused",
};

/** Lapses a pending record inside `tx`: status, cause, the pending list, one `lapsed` record. */
async function lapseIn(
  tx: Tx,
  approvals: { pending: number[] },
  call: HeldCall,
  cause: LapseCause,
  now: number,
  timeZone: string,
): Promise<void> {
  call.status = "lapsed";
  call.lapseCause = cause;
  const index = approvals.pending.indexOf(call.number);
  if (index !== -1) approvals.pending.splice(index, 1);
  await appendRecord(
    tx,
    recordOf({
      key: `approval:${call.number}:lapse`,
      at: now,
      kind: "lapsed",
      number: call.number,
      agent: call.agent,
      tool: call.tool,
      verdict: "lapsed",
      layer: "person",
      reason: LAPSE_REASON[cause],
      ruleId: call.ruleId,
      ruleLevel: call.ruleLevel,
      arguments: call.arguments as Record<string, JsonValue>,
      keep: call.matched,
      cost: 0,
    }),
    timeZone,
  );
}

function lapsedEvent(person: string, call: HeldCall, cause: LapseCause, now: number): void {
  logEvent("approval.lapsed", {
    cell: person,
    request_id: call.requestId,
    call_no: call.number,
    held_ms: now - call.heldAt,
    cause,
  });
}

export function heldEvent(person: string, call: HeldCall): void {
  logEvent("approval.held", {
    cell: person,
    role: call.agent,
    tool: call.tool,
    request_id: call.requestId,
    call_no: call.number,
    reason_source: call.reasonSource,
    expires_at: new Date(call.expiresAt).toISOString(),
  });
}

/** Lapses the held call if it still waits. Returns true when this call lapsed it. */
export async function lapseHeld(
  parts: ApprovalParts,
  number: number,
  cause: LapseCause,
  now: number,
  context: Context,
): Promise<boolean> {
  const lapsed = await parts.harness.commit(async (tx) => {
    const draft = (await tx.doc(ApprovalDoc, String(number), null)).call;
    if (draft === null || draft.status !== "pending") return undefined;
    await lapseIn(tx, await tx.doc(ApprovalsDoc), draft, cause, now, parts.timeZone);
    return copy(draft);
  }, context);
  if (lapsed !== undefined) lapsedEvent(parts.person, lapsed, cause, now);
  return lapsed !== undefined;
}

/** The pending held calls, oldest first; an expired one is lapsed here and left out. */
export async function listHeld(
  parts: ApprovalParts,
  now: number,
  context: Context,
): Promise<HeldCallView[]> {
  const pending = (await parts.harness.snapshot(ApprovalsDoc, context))?.pending ?? [];
  const views: HeldCallView[] = [];
  for (const number of pending) {
    const call = await readHeld(parts.harness, number, context);
    if (call === undefined || call.status !== "pending") continue;
    if (now >= call.expiresAt) {
      await lapseHeld(parts, number, "expired", now, context);
      continue;
    }
    views.push(viewOf(call, now));
  }
  return views;
}

const ANSWER_REASON: Record<AnswerChoice, (person: string) => string> = {
  allow: (person) => `allowed once by ${person}`,
  always: (person) => `allowed always by ${person}`,
  deny: (person) => `denied by ${person}`,
};

const STATUS_OF: Record<AnswerChoice, HeldStatus> = {
  allow: "allowed",
  always: "always",
  deny: "denied",
};

export interface Answered {
  readonly call: HeldCallView;
  readonly answeredBy: string;
  /** The person rule allow always added, when it added one. */
  readonly rule: Rule | null;
}

/**
 * Answers held call `number` in one commit: the status, who answered and from which device, one
 * `answered` activity record, the pending list, and for allow always the person rule. Refusals:
 * NoHeldCall, HeldCallLapsed (an expired record is lapsed in the same commit), HeldCallAnswered,
 * AlwaysNotOffered, and RefusedChange from the rule's checks (nothing is written; the call stays
 * held).
 */
export async function answerHeld(
  parts: ApprovalParts,
  number: number,
  choice: AnswerChoice,
  by: { readonly person: string; readonly device: string },
  now: number,
  context: Context,
): Promise<Answered> {
  type Outcome =
    | { readonly kind: "none" | "answered" }
    | { readonly kind: "lapsed"; readonly call: HeldCall; readonly now: boolean }
    | { readonly kind: "not-offered"; readonly note: string }
    | { readonly kind: "done"; readonly call: HeldCall; readonly rule: Rule | undefined };
  const outcome = await parts.harness.commit(async (tx): Promise<Outcome> => {
    const approvals = await tx.doc(ApprovalsDoc);
    if (!Number.isSafeInteger(number) || number < 1 || number >= approvals.nextNumber) {
      return { kind: "none" };
    }
    const call = (await tx.doc(ApprovalDoc, String(number), null)).call;
    if (call === null) return { kind: "none" };
    if (call.status === "lapsed") return { kind: "lapsed", call: copy(call), now: false };
    if (call.status !== "pending") return { kind: "answered" };
    if (now >= call.expiresAt) {
      await lapseIn(tx, approvals, call, "expired", now, parts.timeZone);
      return { kind: "lapsed", call: copy(call), now: true };
    }
    if (choice === "always" && (!call.always.offered || call.always.rule === null)) {
      return { kind: "not-offered", note: call.always.note ?? NOT_OFFERED_PERSON };
    }
    const rule =
      choice === "always" && call.always.rule !== null
        ? await addAllowAlways(tx, copy(call.always.rule), now)
        : undefined;
    call.status = STATUS_OF[choice];
    call.answeredAt = now;
    call.answeredBy = by.person;
    call.device = by.device;
    const index = approvals.pending.indexOf(number);
    if (index !== -1) approvals.pending.splice(index, 1);
    await appendRecord(
      tx,
      recordOf({
        key: `approval:${number}:answer`,
        at: now,
        kind: "answered",
        number,
        agent: call.agent,
        tool: call.tool,
        verdict: choice === "deny" ? "denied" : "allowed",
        layer: "person",
        reason: ANSWER_REASON[choice](by.person),
        ruleId: call.ruleId,
        ruleLevel: call.ruleLevel,
        arguments: call.arguments as Record<string, JsonValue>,
        keep: call.matched,
        cost: 0,
      }),
      parts.timeZone,
    );
    return { kind: "done", call: copy(call), rule };
  }, context);
  const answered = (late: boolean, call?: HeldCall) =>
    logEvent("approval.answered", {
      cell: parts.person,
      request_id: call?.requestId ?? null,
      call_no: number,
      answer: choice,
      late,
      device: by.device,
    });
  switch (outcome.kind) {
    case "none":
      throw new NoHeldCall(number);
    case "answered":
      throw new HeldCallAnswered(number);
    case "not-offered":
      throw new AlwaysNotOffered(number, outcome.note);
    case "lapsed":
      if (outcome.now) lapsedEvent(parts.person, outcome.call, "expired", now);
      answered(true, outcome.call);
      throw new HeldCallLapsed(number);
    case "done":
      answered(false, outcome.call);
      if (outcome.rule !== undefined) allowAlwaysAdded(parts.person, outcome.rule);
      return {
        call: viewOf(outcome.call, now),
        answeredBy: by.person,
        rule: outcome.rule ?? null,
      };
  }
}

/**
 * Marks an allowed record as used by `callKey`, in one commit. "run": this call may run (also when
 * the same call consumed it before a crash). "used": another call consumed it.
 */
export async function consumeHeld(
  harness: Harness,
  number: number,
  callKey: string,
  context: Context,
): Promise<"run" | "used"> {
  return harness.commit(async (tx) => {
    const call = (await tx.doc(ApprovalDoc, String(number), null)).call;
    if (call === null || (call.status !== "allowed" && call.status !== "always")) return "used";
    if (call.consumedBy !== null && call.consumedBy !== callKey) return "used";
    call.consumedBy = callKey;
    return "run";
  }, context);
}

/**
 * Waits until held call `number` is no longer pending ("changed"), or until the timer for
 * `expiresAt` fires ("timer"; the caller checks the clock, since a long wait may fire early).
 * Rejects when the context is aborted (a job abort, or the harness closing).
 */
export async function waitForAnswer(
  harness: Harness,
  number: number,
  remainingMs: number,
  setTimer: SetTimer,
  context: Context,
): Promise<"changed" | "timer"> {
  const signal = context.abortSignal;
  signal?.throwIfAborted();
  const watch = await harness.watchDoc(ApprovalDoc, String(number), context);
  if (watch === undefined) throw new Error(`held call #${number} has no record`);
  return new Promise((resolve, reject) => {
    let done = false;
    let cancel: () => void = () => {};
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error("aborted")));
    function finish(settle: () => void): void {
      if (done) return;
      done = true;
      cancel();
      signal?.removeEventListener("abort", onAbort);
      void watch?.stop();
      settle();
    }
    const check = (value: Readonly<{ call: HeldCall | null }> | null) => {
      if (value?.call !== null && value?.call !== undefined && value.call.status !== "pending") {
        finish(() => resolve("changed"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    cancel = setTimer(remainingMs, () => finish(() => resolve("timer")));
    check(watch.value);
    if (!done) {
      watch.start(async (value) => {
        check(value);
      });
    }
  });
}
