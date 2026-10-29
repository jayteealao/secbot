/**
 * A person cell's side of shared jobs. A shared job runs in the household; each person's board has
 * its own row for it, with its own number, a `shared` link, and an outbox of operations for the
 * household. One exchange (`syncShared`) sends the outbox and mirrors what the household answers:
 * an offer to this person becomes a row, each row copies the household job's status, cost, cap,
 * tier, pause, and result, a result goes through this person's own inbox (so this person's lead
 * relays it), and each charge of this person's share is booked once on the row's own ledger
 * conversation, where the month and the limits count it. The household never calls a person cell:
 * every exchange is pulled from here.
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { type Harness, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import type { BudgetWaiter } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import {
  ENDED,
  JobBoardDoc,
  type JobRow,
  type JobStatus,
  type ResultKind,
  type SharedLink,
} from "./docs.ts";
import type {
  HouseholdClient,
  SharedOp,
  SharedSyncAnswer,
  SharedSyncRow,
} from "./household-contract.ts";
import { createSharedRow, endRow, placeInQueue } from "./job-board.ts";
import { addToolUsage, costOnlyUsage } from "./month-ledger.ts";
import {
  RESULT_WAKE_MS,
  SHARED_CHARGE_KEY,
  SHARED_OFFER_OPEN_MS,
  SHARED_OPS_UNSENT_AFTER,
  SHARED_SYNC_TIMEOUT_MS,
  sharedJoinedText,
  sharedOfferText,
} from "./release-defaults.ts";

export interface SharedParts {
  readonly harness: Harness;
  readonly person: string;
  readonly household: () => HouseholdClient | undefined;
  readonly now: () => number;
  /** The person's budget gate: a notice to the lead is chat spend, so it waits on the limit. */
  readonly gate?: () => BudgetWaiter | undefined;
  /** Tests: how long one exchange may take (default 10 s). */
  readonly timeoutMs?: number;
}

/** One notice to the lead: its text and its request id (sent once across restarts). */
export type SharedNotice = {
  readonly job: number;
  readonly text: string;
  readonly requestId: string;
  /**
   * Sent without waiting on the person's limit: an offer this person pays nothing for (the
   * requesting person pays all because this person's limit is reached).
   */
  readonly ungated?: boolean;
};

export type SyncOutcome =
  | {
      readonly outcome: "ok";
      readonly ops: number;
      readonly rows: number;
      readonly notices: SharedNotice[];
    }
  | { readonly outcome: "skipped" }
  | { readonly outcome: "failed"; readonly error: string };

let opSeq = 0;

/** A fresh operation id for this person (the household applies each id once). */
export function sharedOpId(person: string, now: number): string {
  opSeq = (opSeq + 1) % 1_000_000;
  return `${person}:shared:${now.toString(36)}:${opSeq}:${Math.random().toString(36).slice(2, 8)}`;
}

/** The operations of every shared row's outbox, oldest row first. */
export function outboxOf(board: { readonly jobs: Readonly<Record<string, JobRow>> }): {
  readonly op: SharedOp;
  readonly job: number;
}[] {
  return Object.values(board.jobs)
    .sort((a, b) => a.number - b.number)
    .flatMap((row) => (row.shared?.outbox ?? []).map((op) => ({ op, job: row.number })));
}

const KINDS: ReadonlySet<string> = new Set(["failure", "question", "risky", "routine"]);

function mirroredStatus(remote: SharedSyncRow): JobStatus {
  if (remote.consent === "asked") return "waiting";
  if (remote.consent === "declined") return "failed";
  return remote.status as JobStatus;
}

/** Moves a mirror row to `status`: an end goes through `endRow`; a row that runs again requeues. */
async function moveTo(tx: Tx, row: JobRow, status: JobStatus, at: number): Promise<void> {
  if (row.status === status) return;
  if (ENDED.has(status)) {
    await endRow(tx, row.number, status, at);
    return;
  }
  const wasEnded = ENDED.has(row.status);
  row.status = status;
  if (wasEnded) {
    row.endedAt = null;
    placeInQueue(await tx.doc(JobBoardDoc), row.number);
  }
}

function emptyLink(remote: SharedSyncRow, role: SharedLink["role"]): SharedLink {
  return {
    household: remote.household,
    role,
    with: role === "requester" ? remote.other : remote.requester,
    consent: role === "requester" ? "asked" : "offered",
    payer: remote.payer,
    estimateUsd: remote.estimateUsd,
    outbox: [],
    charges: [],
    resultAt: null,
    waitingBudget: false,
    syncedAt: null,
  };
}

/** Finds this person's row for a household job, by its household number or its local number. */
function mirrorOf(
  board: { readonly jobs: Record<string, JobRow> },
  remote: SharedSyncRow,
): JobRow | undefined {
  const linked = Object.values(board.jobs).find(
    (row) => row.shared !== null && row.shared.household === remote.household,
  );
  if (linked !== undefined) return linked;
  if (remote.local === null) return undefined;
  const local = board.jobs[String(remote.local)];
  return local?.shared !== null && local?.shared?.household === null ? local : undefined;
}

/**
 * The reconcile commit: acks clear their operations; each household row updates or creates its
 * mirror; new results are stored once; new charges are booked once. Returns the notices to send.
 */
async function reconcile(
  tx: Tx,
  parts: SharedParts,
  sent: readonly { readonly op: SharedOp; readonly job: number }[],
  answer: SharedSyncAnswer,
): Promise<{
  notices: SharedNotice[];
  charged: { job: number; household: number; usd: number; split: string }[];
  offers: { job: number; household: number; waited: number }[];
}> {
  const now = parts.now();
  const board = await tx.doc(JobBoardDoc);
  const notices: SharedNotice[] = [];
  const charged: { job: number; household: number; usd: number; split: string }[] = [];
  const jobOfOp = new Map(sent.map((each) => [each.op.opId, each]));
  for (const ack of answer.acks) {
    const found = jobOfOp.get(ack.opId);
    if (found === undefined) continue;
    const row = board.jobs[String(found.job)];
    const link = row?.shared;
    if (row === undefined || link === null || link === undefined) continue;
    link.outbox = link.outbox.filter((op) => op.opId !== ack.opId);
    if (found.op.kind === "propose") {
      if (ack.household !== undefined) {
        link.household = ack.household;
        if (link.consent === "asking") link.consent = "asked";
      } else if (ack.error !== undefined && !ENDED.has(row.status)) {
        row.result ??= { kind: "failure", text: ack.error, at: now, pulledAt: null, wokeAt: null };
        await endRow(tx, row.number, "failed", now);
        notices.push(resultNotice(row.number, "failure"));
      }
    }
  }
  for (const remote of answer.rows) {
    let row = mirrorOf(board, remote);
    const role = remote.requester === parts.person ? "requester" : "other";
    if (row === undefined) {
      // Only an offer still asked of this person becomes a new row; anything else is history.
      if (role !== "other" || remote.consent !== "asked") continue;
      row = await createSharedRow(tx, {
        title: remote.title,
        brief: remote.title,
        priority: "routine",
        deadline: null,
        tier: remote.tier,
        effort: { requested: remote.effort.requested, applied: remote.effort.applied },
        owner: parts.person,
        createdAt: now,
        shared: emptyLink(remote, "other"),
      });
      notices.push({
        job: row.number,
        text: sharedOfferText(
          row.number,
          remote.requester,
          remote.title,
          remote.estimateUsd / 2,
          remote.payer === "them",
        ),
        requestId: `shared:${row.number}:offer`,
        ...(remote.payer === "them" ? { ungated: true } : {}),
      });
      logEvent("shared.offered", {
        cell: parts.person,
        job: row.number,
        household: remote.household,
        from: remote.requester,
        payer: remote.payer,
      });
    }
    const link = row.shared as SharedLink;
    link.household = remote.household;
    const before = link.consent;
    if (remote.consent === "joined" && before !== "joined") {
      link.consent = "joined";
      if (role === "requester") {
        notices.push({
          job: row.number,
          text: sharedJoinedText(row.number, remote.other, row.title),
          requestId: `shared:${row.number}:joined`,
        });
      }
    } else if (remote.consent === "declined" && before !== "declined") {
      // The requesting row gets the household's stored decline as its failure result below.
      link.consent = "declined";
    } else if (remote.consent === "asked" && role === "requester" && before === "asking") {
      link.consent = "asked";
    }
    link.payer = remote.payer;
    link.estimateUsd = remote.estimateUsd;
    link.waitingBudget = remote.waitingBudget;
    link.syncedAt = now;
    row.tier = remote.tier;
    row.effort = { requested: remote.effort.requested, applied: remote.effort.applied };
    row.attempts = { raises: remote.attempts.raises, restarts: remote.attempts.restarts };
    row.cost = Math.max(row.cost, remote.cost);
    row.cap = remote.cap;
    row.pause =
      remote.pause === null
        ? null
        : {
            reason: remote.pause.reason === "loop" ? "loop" : "cap",
            at: remote.pause.at,
            detail: remote.pause.detail,
          };
    row.block =
      remote.block === null || remote.status !== "blocked"
        ? null
        : {
            cause: remote.block.cause === "hit" ? "hit" : "error",
            kind: "page",
            tool: "",
            chunk: null,
            at: remote.block.at,
          };
    if (
      !(remote.consent === "declined" && role === "other") &&
      remote.result !== null &&
      remote.result.at !== link.resultAt &&
      KINDS.has(remote.result.kind)
    ) {
      const kind = remote.result.kind as ResultKind;
      row.result = {
        kind,
        text: remote.result.text,
        at: remote.result.at,
        pulledAt: null,
        wokeAt: null,
      };
      link.resultAt = remote.result.at;
      if (kind !== "routine") notices.push(resultNotice(row.number, kind));
      logEvent("shared.relayed", {
        cell: parts.person,
        job: row.number,
        household: remote.household,
        kind,
      });
    }
    await moveTo(tx, row, mirroredStatus(remote), now);
    for (const charge of remote.charges) {
      if (charge.person !== parts.person || link.charges.includes(charge.id)) continue;
      if (row.conversationId !== null) {
        await addToolUsage(tx, row.conversationId, SHARED_CHARGE_KEY, costOnlyUsage(charge.usd));
      }
      link.charges.push(charge.id);
      charged.push({
        job: row.number,
        household: remote.household,
        usd: charge.usd,
        split: charge.split,
      });
    }
  }
  // A routine result unpulled for 30 minutes sends one late notice, as the job task does.
  for (const row of Object.values(board.jobs)) {
    const result = row.result;
    if (
      row.shared === null ||
      result === null ||
      result.kind !== "routine" ||
      result.pulledAt !== null ||
      result.wokeAt !== null ||
      now - result.at < RESULT_WAKE_MS
    ) {
      continue;
    }
    notices.push({
      job: row.number,
      text: `[job ${row.number} waited 30 minutes: pull it with job_result]`,
      requestId: `wake:${row.number}:late`,
    });
  }
  // Offers to this person still unanswered, with how long each has waited.
  const offers = Object.values(board.jobs).flatMap((row) => {
    const link = row.shared;
    return link === null ||
      link.role !== "other" ||
      link.household === null ||
      (link.consent !== "offered" && link.consent !== "shown") ||
      ENDED.has(row.status)
      ? []
      : [{ job: row.number, household: link.household, waited: now - row.createdAt }];
  });
  return { notices: keepUnsent(board, notices), charged, offers };
}

/**
 * Keeps every notice on its row until it is delivered: notices an earlier exchange made and never
 * delivered (the cell restarted, or a delivery failed) go first, then the new ones, each once.
 */
function keepUnsent(
  board: { jobs: Record<string, JobRow> },
  fresh: readonly SharedNotice[],
): SharedNotice[] {
  const notices: SharedNotice[] = [];
  const seen = new Set<string>();
  for (const row of Object.values(board.jobs)) {
    for (const kept of row.shared?.unsent ?? []) {
      if (seen.has(kept.requestId)) continue;
      seen.add(kept.requestId);
      notices.push({ ...kept });
    }
  }
  for (const notice of fresh) {
    if (seen.has(notice.requestId)) continue;
    seen.add(notice.requestId);
    notices.push(notice);
    const link = board.jobs[String(notice.job)]?.shared;
    if (link !== null && link !== undefined) {
      link.unsent ??= [];
      link.unsent.push({ ...notice });
    }
  }
  return notices;
}

const resultNotice = (n: number, kind: ResultKind): SharedNotice => ({
  job: n,
  text: `[job ${n} ${kind}: pull it with job_result]`,
  requestId: `wake:${n}:${kind}`,
});

/** Notices that wait on a person's limit, delivered in order behind each other, per cell. */
const deferred = new WeakMap<Harness, Promise<void>>();
/** The request ids already waiting in a cell's chain, so each exchange queues a notice once. */
const queued = new WeakMap<Harness, Set<string>>();

/** Submits one notice to the lead (sent once across restarts by its request id). */
async function deliver(parts: SharedParts, notice: SharedNotice, context: Context) {
  const lead = await parts.harness.conversation(ROOT_CONVERSATION_ID, context);
  await lead?.submit(
    { type: "input", content: notice.text, whenBusy: "followUp", requestId: notice.requestId },
    context,
  );
  await parts.harness.commit(async (tx) => {
    const row = (await tx.doc(JobBoardDoc)).jobs[String(notice.job)];
    const result = row?.result;
    if (result !== undefined && result !== null && notice.requestId.startsWith("wake:")) {
      result.wokeAt ??= parts.now();
    }
    const link = row?.shared;
    if (link?.unsent !== undefined) {
      link.unsent = link.unsent.filter((kept) => kept.requestId !== notice.requestId);
      if (link.unsent.length === 0) delete link.unsent;
    }
  }, context);
}

/**
 * Sends each notice to the lead as a follow-up, after the person's limit allows it; an offer this
 * person pays nothing for goes at once, so a person whose limit is reached still sees it. While
 * the limit is reached, the waiting notices go behind the exchange, so later exchanges still
 * mirror the household.
 */
async function sendNotices(parts: SharedParts, notices: readonly SharedNotice[], context: Context) {
  const gate = parts.gate?.();
  const later: SharedNotice[] = [];
  for (const notice of notices) {
    const waits =
      notice.ungated !== true &&
      gate !== undefined &&
      (later.length > 0 || (await gate.isOver("person", context)));
    if (waits) later.push(notice);
    else await deliver(parts, notice, context);
  }
  const waiting = queued.get(parts.harness) ?? new Set<string>();
  queued.set(parts.harness, waiting);
  // A notice already waiting in the chain (an earlier exchange queued it) is not queued again.
  const fresh = later.filter((notice) => !waiting.has(notice.requestId));
  if (fresh.length === 0 || gate === undefined) return;
  for (const notice of fresh) waiting.add(notice.requestId);
  const before = deferred.get(parts.harness) ?? Promise.resolve();
  const next = before.then(async () => {
    for (const notice of fresh) {
      try {
        await gate.waitUntilUnder(
          { budget: "person", taskId: `shared:${notice.job}`, what: `job ${notice.job} result` },
          context,
        );
        await deliver(parts, notice, context);
      } finally {
        waiting.delete(notice.requestId);
      }
    }
  });
  // A failed delivery (a closing cell) only ends this chain; the next exchange starts a new one.
  // The notices it did not reach may be queued again by a later exchange.
  deferred.set(
    parts.harness,
    next.catch(() => {
      for (const notice of fresh) waiting.delete(notice.requestId);
    }),
  );
}

const running = new WeakMap<Harness, Promise<SyncOutcome>>();

/**
 * What each cell's exchanges logged once: each op's failed exchanges in a row (and when it first
 * failed), the ops already logged as unsent, and the offers already logged as open. Kept in the
 * process, so a restarted cell may log a line once more.
 */
const diagnostics = new WeakMap<
  Harness,
  {
    readonly failures: Map<string, { count: number; since: number }>;
    readonly unsent: Set<string>;
    readonly open: Set<number>;
  }
>();

function diagnosticsOf(harness: Harness) {
  let found = diagnostics.get(harness);
  if (found === undefined) {
    found = { failures: new Map(), unsent: new Set(), open: new Set() };
    diagnostics.set(harness, found);
  }
  return found;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function syncOnce(parts: SharedParts, context: Context): Promise<SyncOutcome> {
  const client = parts.household();
  if (client?.sharedSync === undefined) return { outcome: "skipped" };
  const started = Date.now();
  const board = await parts.harness.snapshot(JobBoardDoc, context);
  const sent = outboxOf(board ?? { jobs: {} });
  let answer: SharedSyncAnswer;
  try {
    answer = await withTimeout(
      client.sharedSync({ person: parts.person, ops: sent.map((each) => each.op) }),
      parts.timeoutMs ?? SHARED_SYNC_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent(
      "shared.sync",
      {
        cell: parts.person,
        ops: sent.length,
        acks: 0,
        rows: 0,
        outcome: "failed",
        duration_ms: Date.now() - started,
      },
      "warn",
    );
    const seen = diagnosticsOf(parts.harness);
    for (const each of sent) {
      const failed = seen.failures.get(each.op.opId) ?? { count: 0, since: parts.now() };
      failed.count += 1;
      seen.failures.set(each.op.opId, failed);
      if (failed.count >= SHARED_OPS_UNSENT_AFTER && !seen.unsent.has(each.op.opId)) {
        seen.unsent.add(each.op.opId);
        logEvent(
          "shared.ops_unsent",
          {
            cell: parts.person,
            job: each.job,
            op: each.op.kind,
            failed_exchanges: failed.count,
            waited_ms: parts.now() - failed.since,
          },
          "warn",
        );
      }
    }
    return { outcome: "failed", error: message };
  }
  const quiet = withoutAbortSignal(context);
  const done = await parts.harness.commit((tx) => reconcile(tx, parts, sent, answer), quiet);
  const seen = diagnosticsOf(parts.harness);
  for (const each of sent) seen.failures.delete(each.op.opId);
  for (const each of done.charged) {
    logEvent("shared.charged", {
      cell: parts.person,
      job: each.job,
      household: each.household,
      usd: each.usd,
      split: each.split,
    });
  }
  for (const offer of done.offers) {
    if (offer.waited < SHARED_OFFER_OPEN_MS || seen.open.has(offer.job)) continue;
    seen.open.add(offer.job);
    logEvent("shared.offer_open", {
      cell: parts.person,
      job: offer.job,
      household: offer.household,
      waited_ms: offer.waited,
    });
  }
  logEvent("shared.sync", {
    cell: parts.person,
    ops: sent.length,
    acks: answer.acks.length,
    rows: answer.rows.length,
    outcome: "ok",
    duration_ms: Date.now() - started,
  });
  await sendNotices(parts, done.notices, quiet);
  return { outcome: "ok", ops: sent.length, rows: answer.rows.length, notices: done.notices };
}

/**
 * One exchange with the household: the outbox goes out, the answer is mirrored in one commit, and
 * the notices go to the lead. One exchange runs at a time per cell; a failed one keeps the outbox
 * for the next.
 */
export function syncShared(parts: SharedParts, context: Context): Promise<SyncOutcome> {
  const before = running.get(parts.harness) ?? Promise.resolve({ outcome: "skipped" } as const);
  const next = before.catch(() => undefined).then(() => syncOnce(parts, context));
  running.set(parts.harness, next);
  return next;
}

/** Starts an exchange in the background (never awaited by a tool); a failure only logs. */
export function kickShared(parts: SharedParts, context: Context): void {
  void syncShared(parts, withoutAbortSignal(context)).catch(() => {});
}
