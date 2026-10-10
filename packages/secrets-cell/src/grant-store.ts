/**
 * The secrets cell's tables: `secrets` (one sealed record per person and name, with its optional
 * broker target), `allowlist` (the owner's: which agent of a person each secret may be granted to),
 * and `grants` (the person's: one secret to one agent). A grant may never sit outside the
 * allowlist: removing an allowlist entry revokes its grant in the same transaction.
 *
 * Every refusal is a `RefusedSecretRequest` with the reason a person reads, and logs one
 * `secret.refused` line with the person, agent, secret, and reason, never a value.
 */
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import {
  CELL_NAME,
  logEvent,
  logName,
  type RotateResult,
  type SecretInput,
  type SecretKind,
  type SecretListing,
} from "@secbot/cell-harness";
import { type BrokerTarget, checkTarget } from "./broker.ts";
import { openSealed, rewrap, type SealedSecret, seal } from "./envelope.ts";
import type { KeyCustody } from "./key-custody.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  person TEXT NOT NULL,
  name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  salt TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrap_iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  broker TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person, name)
);
CREATE TABLE IF NOT EXISTS allowlist (
  person TEXT NOT NULL,
  secret TEXT NOT NULL,
  agent TEXT NOT NULL,
  PRIMARY KEY (person, secret, agent)
);
CREATE TABLE IF NOT EXISTS grants (
  person TEXT NOT NULL,
  secret TEXT NOT NULL,
  agent TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (person, secret, agent)
);
`;

/** A secret's name: lower case, digits, and hyphens. */
export const SECRET_NAME = /^[a-z][a-z0-9-]{0,47}$/;
/** An agent's name: the lead or a specialist (the roster's names). */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A value long enough for the redactor to find, short enough to stay a secret. */
export const VALUE_LIMITS = { min: 8, max: 4_096 } as const;
/** Records re-wrapped per transaction during a rotation. */
export const ROTATION_BATCH = 25;

/** A request the secrets cell refuses; the message is the reason a person reads. */
export class RefusedSecretRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedSecretRequest";
  }
}

type Row = {
  person: string;
  name: string;
  key_id: string;
  salt: string;
  iv: string;
  wrap_iv: string;
  wrapped_key: string;
  ciphertext: string;
  broker: string | null;
  created_at: number;
};

const sealedOf = (row: Row): SealedSecret => ({
  person: row.person,
  name: row.name,
  keyId: row.key_id,
  salt: row.salt,
  iv: row.iv,
  wrapIv: row.wrap_iv,
  wrappedKey: row.wrapped_key,
  ciphertext: row.ciphertext,
});

const brokerOf = (row: Row): BrokerTarget | undefined =>
  row.broker === null ? undefined : (JSON.parse(row.broker) as BrokerTarget);

/** What the store logs about one refusal. */
export interface RefusalContext {
  readonly action: string;
  readonly person: string;
  readonly agent?: string;
  readonly secret?: string;
}

export class SecretStore {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly custody: KeyCustody,
    private readonly now: () => number = Date.now,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.database.exec(SCHEMA).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /**
   * Logs one `secret.refused` and returns the refusal to throw. `detail` is for the log only,
   * where the person and agent may read more than the refusal tells an agent.
   */
  private refuse(context: RefusalContext, reason: string, detail?: string): RefusedSecretRequest {
    logEvent(
      "secret.refused",
      {
        cell: "secrets",
        action: context.action,
        // Not yet checked when a check refuses: a value pasted as a name is never logged.
        person: logName(context.person),
        agent: logName(context.agent),
        secret: logName(context.secret),
        reason,
        ...(detail === undefined ? {} : { detail }),
      },
      "warn",
    );
    return new RefusedSecretRequest(reason);
  }

  private check(context: RefusalContext): void {
    if (!CELL_NAME.test(context.person)) throw this.refuse(context, "no person named that");
    if (context.secret !== undefined && !SECRET_NAME.test(context.secret)) {
      throw this.refuse(context, "a secret's name is lower-case letters, digits, and hyphens");
    }
    if (context.agent !== undefined && !AGENT_NAME.test(context.agent)) {
      throw this.refuse(context, "an agent's name is lower-case letters, digits, and hyphens");
    }
  }

  private async row(person: string, name: string): Promise<Row | undefined> {
    return this.database.get<Row>(
      "SELECT * FROM secrets WHERE person = ? AND name = ?",
      person,
      name,
    );
  }

  private async granted(person: string, secret: string, agent: string): Promise<boolean> {
    const found = await this.database.get<{ agent: string }>(
      "SELECT agent FROM grants WHERE person = ? AND secret = ? AND agent = ?",
      person,
      secret,
      agent,
    );
    return found !== undefined;
  }

  /** The secret a request names, granted to `agent`; refused otherwise. */
  private async grantedRow(context: Required<RefusalContext>): Promise<Row> {
    this.check(context);
    await this.init();
    // One refusal for a missing secret and an ungranted one, so an agent cannot learn which of
    // its person's secret names exist; the log keeps the difference.
    const refusal = `${context.secret} is not granted to ${context.agent}`;
    const row = await this.row(context.person, context.secret);
    if (row === undefined) throw this.refuse(context, refusal, "no such secret");
    if (!(await this.granted(context.person, context.secret, context.agent))) {
      throw this.refuse(context, refusal);
    }
    return row;
  }

  /** The owner stores (or replaces) a secret; grants and the allowlist stay. */
  async add(input: SecretInput): Promise<{ keyId: string; replaced: boolean }> {
    const context = { action: "add", person: input.person, secret: input.name };
    this.check(context);
    if (
      typeof input.value !== "string" ||
      input.value.length < VALUE_LIMITS.min ||
      input.value.length > VALUE_LIMITS.max
    ) {
      throw this.refuse(
        context,
        `a secret value is ${VALUE_LIMITS.min} to ${VALUE_LIMITS.max} characters`,
      );
    }
    let broker: BrokerTarget | undefined;
    if (input.broker !== undefined) {
      try {
        broker = checkTarget(input.broker);
      } catch (error) {
        throw this.refuse(context, error instanceof Error ? error.message : "bad broker target");
      }
    }
    await this.init();
    const sealed = await seal(input.person, input.name, input.value, this.custody);
    const before = await this.row(input.person, input.name);
    const replaced = before !== undefined;
    // A secret that changes between plain and broker loses its grants: an agent granted a broker
    // secret must never read its token because it was added again without its broker target.
    const kindChanged = replaced && (before.broker === null) !== (broker === undefined);
    await this.database.run(
      `INSERT OR REPLACE INTO secrets
        (person, name, key_id, salt, iv, wrap_iv, wrapped_key, ciphertext, broker, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sealed.person,
      sealed.name,
      sealed.keyId,
      sealed.salt,
      sealed.iv,
      sealed.wrapIv,
      sealed.wrappedKey,
      sealed.ciphertext,
      broker === undefined ? null : JSON.stringify(broker),
      this.now(),
    );
    if (kindChanged) {
      await this.database.run(
        "DELETE FROM grants WHERE person = ? AND secret = ?",
        input.person,
        input.name,
      );
      logEvent("secrets.kind_changed", {
        cell: "secrets",
        person: input.person,
        secret: input.name,
        broker: broker?.kind ?? null,
        grants: "revoked",
      });
    }
    return { keyId: sealed.keyId, replaced };
  }

  /** The owner allows (`add`) or stops allowing (`remove`, which also revokes the grant). */
  async allowlist(
    person: string,
    secret: string,
    agent: string,
    action: "add" | "remove",
  ): Promise<{ changed: boolean; revoked: boolean }> {
    const context = { action: `allowlist-${action}`, person, secret, agent };
    this.check(context);
    await this.init();
    if ((await this.row(person, secret)) === undefined) {
      throw this.refuse(context, `no secret named ${secret}`);
    }
    return this.database.transaction(async (tx) => {
      const listed = await tx.get<{ agent: string }>(
        "SELECT agent FROM allowlist WHERE person = ? AND secret = ? AND agent = ?",
        person,
        secret,
        agent,
      );
      if (action === "add") {
        if (listed === undefined) {
          await tx.run(
            "INSERT INTO allowlist (person, secret, agent) VALUES (?, ?, ?)",
            person,
            secret,
            agent,
          );
        }
        return { changed: listed === undefined, revoked: false };
      }
      const grant = await tx.get<{ agent: string }>(
        "SELECT agent FROM grants WHERE person = ? AND secret = ? AND agent = ?",
        person,
        secret,
        agent,
      );
      await tx.run(
        "DELETE FROM allowlist WHERE person = ? AND secret = ? AND agent = ?",
        person,
        secret,
        agent,
      );
      await tx.run(
        "DELETE FROM grants WHERE person = ? AND secret = ? AND agent = ?",
        person,
        secret,
        agent,
      );
      return { changed: listed !== undefined, revoked: grant !== undefined };
    });
  }

  /**
   * A person grants one of their secrets to one of their agents (the calling person cell checks
   * that the agent is on the person's roster); only inside the owner's allowlist.
   */
  async grant(person: string, secret: string, agent: string): Promise<{ granted: boolean }> {
    const context = { action: "grant", person, secret, agent };
    this.check(context);
    await this.init();
    if ((await this.row(person, secret)) === undefined) {
      throw this.refuse(context, `no secret named ${secret}`);
    }
    const allowed = await this.database.get<{ agent: string }>(
      "SELECT agent FROM allowlist WHERE person = ? AND secret = ? AND agent = ?",
      person,
      secret,
      agent,
    );
    if (allowed === undefined) {
      throw this.refuse(context, `${secret} is not in the owner's allowlist for ${agent}`);
    }
    const before = await this.granted(person, secret, agent);
    if (!before) {
      await this.database.run(
        "INSERT INTO grants (person, secret, agent, granted_at) VALUES (?, ?, ?, ?)",
        person,
        secret,
        agent,
        this.now(),
      );
    }
    return { granted: !before };
  }

  async revoke(person: string, secret: string, agent: string): Promise<{ revoked: boolean }> {
    const context = { action: "revoke", person, secret, agent };
    this.check(context);
    await this.init();
    if (!(await this.granted(person, secret, agent))) {
      throw this.refuse(context, `${secret} is not granted to ${agent}`);
    }
    await this.database.run(
      "DELETE FROM grants WHERE person = ? AND secret = ? AND agent = ?",
      person,
      secret,
      agent,
    );
    return { revoked: true };
  }

  /** The value of a granted, non-broker secret. */
  async get(person: string, agent: string, secret: string): Promise<string> {
    const context = { action: "get", person, agent, secret };
    const row = await this.grantedRow(context);
    if (row.broker !== null) {
      throw this.refuse(context, `${secret} is used only through the broker`);
    }
    return openSealed(sealedOf(row), this.custody);
  }

  /** The token and target of a granted broker secret; refused for a plain secret. */
  async brokerSecret(
    person: string,
    agent: string,
    secret: string,
  ): Promise<{ target: BrokerTarget; token: string }> {
    const context = { action: "broker", person, agent, secret };
    const row = await this.grantedRow(context);
    const target = brokerOf(row);
    if (target === undefined) throw this.refuse(context, `${secret} is not a broker secret`);
    return { target, token: await openSealed(sealedOf(row), this.custody) };
  }

  /** A refusal for a request the broker itself refused (bad path or method). */
  refusedBroker(
    person: string,
    agent: string,
    secret: string,
    reason: string,
  ): RefusedSecretRequest {
    return this.refuse({ action: "broker", person, agent, secret }, reason);
  }

  /** A person's secrets, their grants, and the owner's allowlist; never a value. */
  async list(person: string): Promise<SecretListing[]> {
    this.check({ action: "list", person });
    await this.init();
    const rows = await this.database.all<Row>(
      "SELECT * FROM secrets WHERE person = ? ORDER BY name",
      person,
    );
    const grants = await this.database.all<{ secret: string; agent: string }>(
      "SELECT secret, agent FROM grants WHERE person = ? ORDER BY agent",
      person,
    );
    const allowed = await this.database.all<{ secret: string; agent: string }>(
      "SELECT secret, agent FROM allowlist WHERE person = ? ORDER BY agent",
      person,
    );
    return rows.map((row) => ({
      name: row.name,
      kind: (brokerOf(row)?.kind ?? "secret") as SecretKind,
      grants: grants.filter((g) => g.secret === row.name).map((g) => g.agent),
      allowed: allowed.filter((a) => a.secret === row.name).map((a) => a.agent),
      keyId: row.key_id,
      createdAt: Number(row.created_at),
    }));
  }

  /** The values of a person's granted non-broker secrets, for that person cell's redactor. */
  async redactionValues(person: string): Promise<string[]> {
    this.check({ action: "redaction-values", person });
    await this.init();
    const rows = await this.database.all<Row>(
      `SELECT * FROM secrets WHERE person = ? AND broker IS NULL
        AND name IN (SELECT secret FROM grants WHERE person = ?) ORDER BY name`,
      person,
      person,
    );
    const values: string[] = [];
    for (const row of rows) values.push(await openSealed(sealedOf(row), this.custody));
    return values;
  }

  /** Raw records, for the tests' look at what is stored. */
  async rawRecords(): Promise<Row[]> {
    await this.init();
    return this.database.all<Row>("SELECT * FROM secrets ORDER BY person, name");
  }

  /**
   * Makes the next master key current (the helper creates it on the host), then re-wraps every
   * record under an older key in batches; each record changes in one write that checks its key id
   * did not move. A read during the rotation uses whichever key id and salt its record carries.
   */
  async rotate(
    options: { readonly batch?: number; readonly afterBatch?: () => Promise<void> } = {},
  ): Promise<RotateResult> {
    await this.init();
    const from = await this.custody.currentKeyId();
    const keyId = await this.custody.rotate(from);
    const batch = Math.max(1, options.batch ?? ROTATION_BATCH);
    let rewrapped = 0;
    for (;;) {
      const rows = await this.database.all<Row>(
        "SELECT * FROM secrets WHERE key_id != ? ORDER BY person, name LIMIT ?",
        keyId,
        batch,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const next = await rewrap(sealedOf(row), keyId, this.custody);
        await this.database.run(
          `UPDATE secrets SET key_id = ?, salt = ?, wrap_iv = ?, wrapped_key = ?
            WHERE person = ? AND name = ? AND key_id = ? AND salt = ?`,
          next.keyId,
          next.salt,
          next.wrapIv,
          next.wrappedKey,
          row.person,
          row.name,
          row.key_id,
          row.salt,
        );
        rewrapped += 1;
      }
      await options.afterBatch?.();
    }
    const left = await this.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM secrets WHERE key_id != ?",
      keyId,
    );
    return { from, keyId, rewrapped, remaining: Number(left?.count ?? 0) };
  }
}
