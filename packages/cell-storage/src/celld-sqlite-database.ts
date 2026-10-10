/**
 * pi-durable `SqliteDatabase` driver over celld Durable Object storage.
 *
 * What celld v0.6.1 does, read in `crates/celld/js/harness.js` (source: .scratch/sources/git/celld,
 * tag v0.6.1) before this driver was written:
 * - `DurableObjectStorage.transaction(f)` (harness.js:1898-2006, with `_runTransactionWith` at 1832) awaits `f(view)`, so it spans
 *   awaits. It runs under `blockConcurrencyWhile`, so no other event enters the object while it
 *   is open. A rejected callback rolls the savepoint back and rejects with the same error.
 * - A call from the SAME event while a transaction is open joins it (harness.js:1911-1914,
 *   `root._activeTransaction.transaction(f)`; `sql.exec` on the root runs on the same
 *   connection). pi-durable's contract requires such calls to wait instead, so every call goes
 *   through one operation queue (`SerialOperationQueue`).
 * - A failed rollback does not reject with a second error: celld aborts the object and rethrows
 *   the callback's error (harness.js:1880-1897, `_abortAfterFailedRollback`). The driver detects
 *   the abort with a probe statement and rejects with an `AggregateError`, as the contract asks.
 * - The 30-second limit (harness.js:2730-2745) rejects the transaction with "A call to
 *   blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and
 *   the Durable Object was reset." and rolls the open transaction back. The driver maps it to
 *   `CellStorageTransactionTimeout` and closes itself; the cell opens a new driver on its next
 *   event.
 * - `sql.exec` runs several statements in one call (crates/celld/storage.rs:1915-1971) and
 *   serializes bindings with `JSON.stringify` (harness.js:1401-1435), so a `bigint` binding is
 *   converted here.
 * - A block started by work whose cell event already ended is refused before its callback runs,
 *   with "the cell event ended before it could acquire an input gate" (harness.js:2614-2623 and
 *   the gate acquire in js.rs). Nothing was written, so the driver reports it as pi-durable's
 *   `StorageRejected`; any other error would make pi-durable poison its session for good.
 */
import { StorageRejected } from "@earendil-works/pi-durable";
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import type { CelldSqlBinding, CelldSqlStorage, CelldStorage } from "./celld-types.ts";
import { SerialOperationQueue } from "./serial-queue.ts";

/** The class name the conformance run reports, so a test can prove which driver ran. */
export const ADAPTER_NAME = "CelldSqliteDatabase";

/** celld's own limit on one transaction (docs/services/durable-objects.md:169-170). */
export const CELLD_TRANSACTION_LIMIT_MS = 30_000;

const RESET_MESSAGES = ["waited for too long", "Durable Object was reset"] as const;

/** celld's refusal of a block whose cell event already ended (harness.js:2621, js.rs:1300). */
export const RETIRED_INPUT_GATE = "the cell event ended before it could acquire an input gate";

const isRetiredGate = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(RETIRED_INPUT_GATE);

/** The transaction ran past celld's 30-second limit; celld reset the object and rolled it back. */
export class CellStorageTransactionTimeout extends Error {
  readonly durationMs: number;

  constructor(durationMs: number, cause: unknown) {
    super(
      `cell storage transaction timed out after ${durationMs} ms; celld rolled it back and reset the cell`,
      { cause },
    );
    this.name = "CellStorageTransactionTimeout";
    this.durationMs = durationMs;
  }
}

/** The driver was closed, or a reset ended it; the cell must open a new one. */
export class CellStorageClosedError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`cell storage is closed: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "CellStorageClosedError";
  }
}

export interface CelldSqliteDatabaseOptions {
  /** Clock for the timeout duration; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Receives one JSON line per transaction timeout; defaults to `console.error`. */
  readonly log?: (line: string) => void;
}

const isResetError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return RESET_MESSAGES.some((part) => message.includes(part));
};

const toBinding = (value: SqliteValue): CelldSqlBinding => {
  if (typeof value !== "bigint") return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`SQLite binding ${value} is outside the safe integer range celld accepts`);
  }
  return Number(value);
};

const execute = (sql: CelldSqlStorage, query: string, params: readonly SqliteValue[]) =>
  // toArray() reads the cursor to its end: celld rejects a response while a write cursor is open.
  sql.exec(query, ...params.map(toBinding)).toArray();

type TransactionScope = { active: boolean };

class CelldSqliteTransaction implements SqliteExecutor {
  private readonly sql: CelldSqlStorage;
  private readonly scope: TransactionScope;

  constructor(sql: CelldSqlStorage, scope: TransactionScope) {
    this.sql = sql;
    this.scope = scope;
  }

  async exec(query: string): Promise<void> {
    this.assertActive();
    execute(this.sql, query, []);
  }

  async run(query: string, ...params: SqliteValue[]): Promise<void> {
    this.assertActive();
    execute(this.sql, query, params);
  }

  async get<T extends object>(query: string, ...params: SqliteValue[]): Promise<T | undefined> {
    this.assertActive();
    return execute(this.sql, query, params)[0] as T | undefined;
  }

  async all<T extends object>(query: string, ...params: SqliteValue[]): Promise<T[]> {
    this.assertActive();
    return execute(this.sql, query, params) as T[];
  }

  private assertActive(): void {
    if (!this.scope.active) throw new Error("cell storage transaction handle is no longer active");
  }
}

/** `SqliteDatabase` over one celld object's `ctx.storage`. */
export class CelldSqliteDatabase implements SqliteDatabase {
  readonly adapter = ADAPTER_NAME;
  private readonly storage: CelldStorage;
  private readonly queue = new SerialOperationQueue();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private closedBy: Error | undefined;

  constructor(storage: CelldStorage, options: CelldSqliteDatabaseOptions = {}) {
    this.storage = storage;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(line));
  }

  exec(query: string): Promise<void> {
    return this.queue.run(() => {
      this.assertOpen();
      execute(this.storage.sql, query, []);
    });
  }

  run(query: string, ...params: SqliteValue[]): Promise<void> {
    return this.queue.run(() => {
      this.assertOpen();
      execute(this.storage.sql, query, params);
    });
  }

  get<T extends object>(query: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.queue.run(() => {
      this.assertOpen();
      return execute(this.storage.sql, query, params)[0] as T | undefined;
    });
  }

  all<T extends object>(query: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.queue.run(() => {
      this.assertOpen();
      return execute(this.storage.sql, query, params) as T[];
    });
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue.runAsync(async () => {
      this.assertOpen();
      const startedAt = this.now();
      const scope: TransactionScope = { active: true };
      let started = false;
      try {
        return await this.storage.transaction(async (view) => {
          started = true;
          const result = await callback(new CelldSqliteTransaction(view.sql, scope));
          // The handle stops before celld commits, as the SqliteDatabase contract requires.
          scope.active = false;
          return result;
        });
      } catch (error) {
        scope.active = false;
        if (!started && isRetiredGate(error)) {
          // celld refused the gate before the callback ran: no statement ran, nothing committed.
          throw new StorageRejected(
            "celld refused the cell storage transaction before it started",
            {
              cause: error,
            },
          );
        }
        if (isResetError(error)) throw this.timedOut(startedAt, error);
        const rollbackFailure = this.probe();
        if (rollbackFailure !== undefined) {
          this.closedBy = new CellStorageClosedError(
            "celld aborted the cell after a failed rollback",
            rollbackFailure,
          );
          throw new AggregateError(
            [error, rollbackFailure],
            "cell storage transaction failed and its rollback could not be confirmed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.queue.run(() => {
      // celld owns the connection; closing the driver only stops further use.
      this.closedBy ??= new CellStorageClosedError("close() was called");
    });
  }

  private timedOut(startedAt: number, cause: unknown): CellStorageTransactionTimeout {
    const durationMs = this.now() - startedAt;
    const timeout = new CellStorageTransactionTimeout(durationMs, cause);
    this.closedBy = new CellStorageClosedError(
      "a transaction timed out and celld reset the cell",
      timeout,
    );
    this.log(
      JSON.stringify({ event: "cell_storage.transaction_timeout", duration_ms: durationMs }),
    );
    return timeout;
  }

  /** Returns the error a trivial statement raises, or undefined when the storage still answers. */
  private probe(): unknown {
    try {
      this.storage.sql.exec("SELECT 1").toArray();
      return undefined;
    } catch (probeError) {
      return probeError;
    }
  }

  private assertOpen(): void {
    if (this.closedBy !== undefined) throw this.closedBy;
  }
}
