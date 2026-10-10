/**
 * `SecretsCell`: the one Durable Object named "secrets". It holds every person's secrets sealed
 * under envelope encryption (envelope.ts), the owner's allowlist and the persons' grants
 * (grant-store.ts), and the broker for health and production targets (broker.ts). Person cells
 * reach it over the private network at `/internal/secrets/*` with the operator key, or through
 * the binding's stub in one fleet (packages/cell-worker/src/secrets-client.ts).
 *
 * Before anything opens, the cell asks the key helper whether its key files are usable; when they
 * are missing, readable by another user, or the helper does not answer, the cell refuses to start,
 * logs `secrets.refused_start {reason}`, and every request gets "secrets cell unavailable". It
 * runs the heartbeat routine like every cell (a minimal pi-durable harness on the same database).
 *
 * Every method returns `SecretsAnswer` instead of throwing, so a refusal keeps its status and its
 * reason across celld RPC. Nothing here logs, returns, or stores a value or a key in clear.
 * The cell is never snapshotted or restored: the release tool skips it, and a lost cell is rebuilt
 * and its credentials rotated (scripts/vps.mjs restore).
 */
import type { Harness } from "@earendil-works/pi-durable";
import {
  type AlarmReport,
  alarmVerdict,
  type BrokerAnswer,
  type BrokerRequest,
  CellAlarm,
  errorFields,
  HarnessSlot,
  type HeartbeatEnv,
  type HeartbeatState,
  heartbeatState,
  logEvent,
  type NextWake,
  openRoutineHarness,
  type RotateResult,
  SECRETS_UNAVAILABLE,
  type SecretInput,
  type SecretListing,
  type WakeSummary,
} from "@secbot/cell-harness";
import {
  type CelldAlarmInfo,
  type CelldCellStorage,
  openCelldStorageWithDatabase,
} from "@secbot/cell-storage";
import { BrokerRequestRefused, type BrokerTiming, brokerCall } from "./broker.ts";
import { RefusedSecretRequest, SecretStore } from "./grant-store.ts";
import { helperCustody, type KeyCustody, KeyCustodyUnavailable } from "./key-custody.ts";

export const SECRETS_CELL_NAME = "secrets";

/** A refused start with an unchanged reason is logged again after this many attempts. */
const REFUSED_LOG_EVERY = 50;

export interface SecretsCellState {
  readonly storage: CelldCellStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface SecretsCellEnv extends HeartbeatEnv {
  /** The key helper's loopback address (http://127.0.0.1:<port>), filled by the release tool. */
  readonly SECBOT_KEY_HELPER_URL?: string;
}

export interface SecretsCellOptions {
  /** The release version; set by the worker from the bundle. */
  readonly version?: string;
  /** The key custody; the key helper at SECBOT_KEY_HELPER_URL when absent. */
  readonly custody?: KeyCustody;
  /** Tests: a clock; defaults to Date.now. */
  readonly now?: () => number;
  /** The fetch for broker calls and heartbeat pings. */
  readonly fetch?: typeof fetch;
  /** Tests: how often a settling alarm looks at the tasks. */
  readonly pollMs?: number;
  /** Tests: records per rotation batch, and a step between batches. */
  readonly rotationBatch?: number;
  readonly afterRotationBatch?: () => Promise<void>;
}

/** A method's answer: the value, or a status and the reason a person reads. */
export type SecretsAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

interface Opened {
  readonly store: SecretStore;
  readonly harness: Harness;
  readonly wakes: () => Promise<{
    readonly summary: WakeSummary;
    readonly next: NextWake | undefined;
  }>;
  /** Logs the count of reports not logged yet, then closes the harness. */
  close(): Promise<void>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The caller's request id for the log, when it is a short id; never other text. */
const requestIdOf = (input: { requestId?: unknown }): string | null =>
  typeof input.requestId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(input.requestId)
    ? input.requestId
    : null;

export class SecretsCell {
  /** The routine harness: closed and opened again when celld closes the database under it. */
  private readonly slot: HarnessSlot<Opened>;
  /** The open that `open()` watches for a failure to log. */
  private watched: Promise<Opened> | undefined;
  private readonly alarms: CellAlarm;
  private readonly now: () => number;
  private readonly custody: KeyCustody;
  /** The reason the last open was refused, and how many opens it refused in a row. */
  private refused: { readonly reason: string; count: number } | undefined;

  constructor(
    private readonly state: SecretsCellState,
    private readonly env: SecretsCellEnv,
    private readonly options: SecretsCellOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.custody = options.custody ?? helperCustody(env.SECBOT_KEY_HELPER_URL ?? "", options.fetch);
    this.alarms = new CellAlarm(state.storage, SECRETS_CELL_NAME, {
      now: this.now,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    });
    this.slot = new HarnessSlot(
      SECRETS_CELL_NAME,
      (onReport) => this.openNow(onReport),
      (work) => this.state.waitUntil?.(work),
    );
  }

  private open(): Promise<Opened> {
    const opening = this.slot.get();
    if (opening !== this.watched) {
      this.watched = opening;
      // A failed open leaves the slot empty, so the next request tries again.
      opening.catch((error: unknown) => {
        if (!(error instanceof KeyCustodyUnavailable)) {
          logEvent("cell.open_failed", { cell: SECRETS_CELL_NAME, ...errorFields(error) }, "error");
        }
      });
    }
    return opening;
  }

  private async openNow(onReport: (error: unknown) => void): Promise<Opened> {
    // No route answers without a usable key: the key files are checked before anything opens.
    const health = await this.custody.health();
    if (!health.ok) {
      this.refusedStart(health.reason);
      throw new KeyCustodyUnavailable(health.reason);
    }
    this.refused = undefined;
    const { storage, database } = await openCelldStorageWithDatabase(this.state.storage);
    const routine = await openRoutineHarness(
      {
        cell: SECRETS_CELL_NAME,
        storage,
        env: this.env,
        now: this.now,
        onReport,
        onWakeChange: () => this.rearmSoon(),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      },
      (opened) => this.alarms.rearm(opened),
    );
    logEvent("secrets.started", {
      cell: SECRETS_CELL_NAME,
      key_id: health.current,
      key_ids: health.keyIds.length,
    });
    return { ...routine, store: new SecretStore(database, this.custody, this.now) };
  }

  /**
   * Logs `secrets.refused_start` when the reason is new, then once every REFUSED_LOG_EVERY
   * attempts with the count, so a helper outage does not log a line for every request.
   */
  private refusedStart(reason: string): void {
    const refused = this.refused?.reason === reason ? this.refused : { reason, count: 0 };
    refused.count++;
    this.refused = refused;
    if (refused.count === 1 || refused.count % REFUSED_LOG_EVERY === 0) {
      logEvent(
        "secrets.refused_start",
        { cell: SECRETS_CELL_NAME, reason, attempts: refused.count },
        "error",
      );
    }
  }
  private rearmSoon(): void {
    const opening = this.slot.current();
    if (opening === undefined) return;
    const work = opening
      .then((opened) => this.alarms.rearm(opened))
      .catch((error: unknown) => {
        logEvent("alarm.rearm_failed", { cell: SECRETS_CELL_NAME, ...errorFields(error) }, "error");
      });
    this.state.waitUntil?.(work);
  }

  /** Runs one method: a refusal is 400, no usable key or helper 503, anything else 500. */
  private async answer<T>(
    method: string,
    work: (store: SecretStore) => Promise<T>,
  ): Promise<SecretsAnswer<T>> {
    try {
      const { store } = await this.open();
      return { ok: true, value: await work(store) };
    } catch (error) {
      if (error instanceof RefusedSecretRequest) {
        return { ok: false, status: 400, error: error.message };
      }
      if (error instanceof KeyCustodyUnavailable) {
        logEvent(
          "secrets.unavailable",
          { cell: SECRETS_CELL_NAME, method, reason: error.reason },
          "error",
        );
        return { ok: false, status: 503, error: SECRETS_UNAVAILABLE };
      }
      logEvent(
        "secrets.error",
        { cell: SECRETS_CELL_NAME, method, ...errorFields(error) },
        "error",
      );
      return { ok: false, status: 500, error: "the secrets cell failed" };
    }
  }

  /** RPC: the value of a non-broker secret granted to `agent` of `person`. */
  get(input: {
    person: string;
    agent: string;
    name: string;
    requestId?: string;
  }): Promise<SecretsAnswer<{ value: string }>> {
    return this.answer("get", async (store) => {
      const value = await store.get(text(input.person), text(input.agent), text(input.name));
      logEvent("secrets.granted", {
        cell: SECRETS_CELL_NAME,
        person: input.person,
        agent: input.agent,
        secret: input.name,
        request_id: requestIdOf(input),
      });
      return { value };
    });
  }

  /** RPC: makes a call to a granted health or production target with its token. */
  broker(input: {
    person: string;
    agent: string;
    name: string;
    request: BrokerRequest;
    requestId?: string;
  }): Promise<SecretsAnswer<BrokerAnswer>> {
    return this.answer("broker", async (store) => {
      const person = text(input.person);
      const agent = text(input.agent);
      const name = text(input.name);
      const { target, token } = await store.brokerSecret(person, agent, name);
      const request = input.request ?? ({} as BrokerRequest);
      let answer: BrokerAnswer;
      let timing: BrokerTiming = { cause: null, durationMs: 0 };
      try {
        answer = await brokerCall(target, token, request, this.options.fetch, (seen) => {
          timing = seen;
        });
      } catch (error) {
        if (error instanceof BrokerRequestRefused) {
          throw store.refusedBroker(person, agent, name, error.message);
        }
        throw error;
      }
      logEvent("secrets.brokered", {
        cell: SECRETS_CELL_NAME,
        person,
        agent,
        secret: name,
        kind: target.kind,
        method: typeof request.method === "string" ? request.method : null,
        status: answer.status,
        cause: timing.cause,
        duration_ms: timing.durationMs,
        request_id: requestIdOf(input),
      });
      return answer;
    });
  }

  /** RPC: a person's secrets, grants, and allowlist; never a value. */
  list(input: { person: string }): Promise<SecretsAnswer<SecretListing[]>> {
    return this.answer("list", (store) => store.list(text(input.person)));
  }

  /** RPC: a person grants a secret to an agent the person cell checked against its roster. */
  grant(input: {
    person: string;
    secret: string;
    agent: string;
  }): Promise<SecretsAnswer<{ granted: boolean }>> {
    return this.answer("grant", async (store) => {
      const result = await store.grant(text(input.person), text(input.secret), text(input.agent));
      logEvent("secrets.grant", {
        cell: SECRETS_CELL_NAME,
        person: input.person,
        secret: input.secret,
        agent: input.agent,
        outcome: result.granted ? "granted" : "already",
      });
      return result;
    });
  }

  revoke(input: {
    person: string;
    secret: string;
    agent: string;
  }): Promise<SecretsAnswer<{ revoked: boolean }>> {
    return this.answer("revoke", async (store) => {
      const result = await store.revoke(text(input.person), text(input.secret), text(input.agent));
      logEvent("secrets.grant", {
        cell: SECRETS_CELL_NAME,
        person: input.person,
        secret: input.secret,
        agent: input.agent,
        outcome: "revoked",
      });
      return result;
    });
  }

  /** RPC (owner): stores a secret; its value never leaves the cell again in clear. */
  add(input: SecretInput): Promise<SecretsAnswer<{ keyId: string; replaced: boolean }>> {
    return this.answer("add", async (store) => {
      const result = await store.add({
        person: text(input?.person),
        name: text(input?.name),
        value: text(input?.value),
        ...(input?.broker === undefined || input.broker === null ? {} : { broker: input.broker }),
      });
      logEvent("secrets.stored", {
        cell: SECRETS_CELL_NAME,
        person: input.person,
        secret: input.name,
        broker: input.broker?.kind ?? null,
        key_id: result.keyId,
        replaced: result.replaced,
      });
      return result;
    });
  }

  /** RPC (owner): adds or removes an allowlist entry; removing one revokes its grant. */
  allowlist(input: {
    person: string;
    secret: string;
    agent: string;
    action: "add" | "remove";
  }): Promise<SecretsAnswer<{ changed: boolean; revoked: boolean }>> {
    return this.answer("allowlist", async (store) => {
      const action = input.action === "remove" ? "remove" : "add";
      const result = await store.allowlist(
        text(input.person),
        text(input.secret),
        text(input.agent),
        action,
      );
      logEvent("secrets.allowlist", {
        cell: SECRETS_CELL_NAME,
        person: input.person,
        secret: input.secret,
        agent: input.agent,
        action,
        changed: result.changed,
        revoked: result.revoked,
      });
      return result;
    });
  }

  /** RPC (owner): the next master key becomes current and every record is re-wrapped under it. */
  rotate(_input: unknown = {}): Promise<SecretsAnswer<RotateResult>> {
    return this.answer("rotate", async (store) => {
      const result = await store.rotate({
        ...(this.options.rotationBatch === undefined ? {} : { batch: this.options.rotationBatch }),
        ...(this.options.afterRotationBatch === undefined
          ? {}
          : { afterBatch: this.options.afterRotationBatch }),
      });
      logEvent("secrets.rotated", {
        cell: SECRETS_CELL_NAME,
        from: result.from,
        key_id: result.keyId,
        rewrapped: result.rewrapped,
        remaining: result.remaining,
      });
      return result;
    });
  }

  /** RPC: the values a person cell's redactor must know (its person's granted plain secrets). */
  redactionValues(input: { person: string }): Promise<SecretsAnswer<{ values: string[] }>> {
    return this.answer("redaction-values", async (store) => ({
      values: await store.redactionValues(text(input.person)),
    }));
  }

  /** RPC: up with the release version (check:cells); throws with the reason when it refused to start. */
  async status(): Promise<{ status: "up"; version: string; roles: string[] }> {
    try {
      await this.open();
    } catch (error) {
      if (error instanceof KeyCustodyUnavailable) {
        throw new Error(`the secrets cell refused to start: ${error.reason}`);
      }
      throw error;
    }
    return { status: "up", version: this.options.version ?? "0.0.0-dev", roles: [] };
  }

  /** RPC: the stored alarm against the earliest stored timer (check:alarms). */
  async alarmReport(): Promise<AlarmReport> {
    const alarm = await this.state.storage.getAlarm();
    const opened = await this.open();
    const { summary } = await opened.wakes();
    return alarmVerdict(SECRETS_CELL_NAME, alarm, summary);
  }

  /** RPC: the heartbeat routine's last run (check:heartbeats). */
  async heartbeat(): Promise<HeartbeatState> {
    return heartbeatState((await this.open()).harness);
  }

  /** celld's alarm: resume the routines, wait while due work runs, re-arm. */
  async alarm(info?: CelldAlarmInfo): Promise<void> {
    this.alarms.fired(info, undefined);
    const opened = await this.open();
    await this.alarms.settle(opened);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.status());
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Tests: closes the routine harness. */
  async close(): Promise<void> {
    await this.slot.close();
  }

  /** Tests: the store, to read raw records. */
  async storeForTests(): Promise<SecretStore> {
    return (await this.open()).store;
  }
}
