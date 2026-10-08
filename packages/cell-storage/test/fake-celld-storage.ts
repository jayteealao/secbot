/**
 * A test double of celld's `ctx.storage` on `node:sqlite`, close to celld v0.6.1
 * `crates/celld/js/harness.js` where the driver depends on it:
 * - `sql.exec` is synchronous, runs several statements when there are no bindings, and returns
 *   a cursor; a root `sql.exec` during an open transaction lands inside it (one connection).
 * - `transaction(f)` uses a savepoint, awaits `f(view)`, and rolls back on rejection.
 * - A failed rollback aborts the object and rethrows the callback's error.
 * - A transaction past the limit (30 s in celld; settable here) rolls back, resets the object,
 *   and rejects with celld's message.
 * - One alarm per object (`getAlarm`, `setAlarm`, `deleteAlarm`); celld fires a due alarm and
 *   consumes it, which `takeDueAlarm(now)` stands in for.
 * - With `file`, the database lives in a file, so a process that is killed mid-transaction leaves
 *   it as a crash would and a new stand-in on the same file sees only committed writes. The alarm
 *   is kept in the same file, as celld keeps it in the cell's SQLite.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  CelldAlarmStorage,
  CelldSqlBinding,
  CelldSqlCursor,
  CelldSqlRow,
  CelldSqlStorage,
  CelldStorage,
} from "../src/celld-types.ts";

const RESET_MESSAGE =
  "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.";

export interface FakeCelldStorageOptions {
  /** Transaction limit in milliseconds; celld's is 30,000. */
  readonly transactionLimitMs?: number;
  /** A database file in place of memory (crash tests reopen it in another process). */
  readonly file?: string;
}

class FakeCursor implements CelldSqlCursor {
  private readonly rows: CelldSqlRow[];

  constructor(rows: CelldSqlRow[]) {
    this.rows = rows;
  }

  toArray(): CelldSqlRow[] {
    return [...this.rows];
  }

  [Symbol.iterator](): Iterator<CelldSqlRow> {
    return this.rows[Symbol.iterator]();
  }
}

const ALARM_TABLE =
  "CREATE TABLE IF NOT EXISTS _fake_celld_alarm (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)";

export class FakeCelldStorage implements CelldStorage, CelldAlarmStorage {
  readonly database: DatabaseSync;
  readonly sql: CelldSqlStorage;
  /** Every statement in run order, for ordering assertions. */
  readonly statements: string[] = [];
  /** When true, the next rollback fails the way a broken connection would. */
  failNextRollback = false;
  /** How many times `setAlarm()` ran (each one is a bucket write on celld). */
  alarmWrites = 0;
  private aborted = false;
  private savepoints = 0;
  private resetOpenTransaction: (() => void) | undefined;
  private readonly transactionLimitMs: number;

  constructor(options: FakeCelldStorageOptions = {}) {
    this.transactionLimitMs = options.transactionLimitMs ?? 30_000;
    this.database = new DatabaseSync(options.file ?? ":memory:");
    this.database.exec(ALARM_TABLE);
    this.sql = { exec: (query, ...bindings) => this.exec(query, bindings) };
  }

  async getAlarm(): Promise<number | null> {
    this.assertLive();
    const row = this.database.prepare("SELECT at FROM _fake_celld_alarm WHERE id = 1").get() as
      | { at: number }
      | undefined;
    return row === undefined ? null : Number(row.at);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.assertLive();
    this.alarmWrites++;
    this.database
      .prepare("INSERT OR REPLACE INTO _fake_celld_alarm (id, at) VALUES (1, ?)")
      .run(Math.trunc(scheduledTime));
  }

  async deleteAlarm(): Promise<void> {
    this.assertLive();
    this.database.exec("DELETE FROM _fake_celld_alarm");
  }

  /** Consumes the alarm when it is due at `now`, as celld does before it calls `alarm()`. */
  takeDueAlarm(now: number): number | undefined {
    const row = this.database.prepare("SELECT at FROM _fake_celld_alarm WHERE id = 1").get() as
      | { at: number }
      | undefined;
    if (row === undefined || Number(row.at) > now) return undefined;
    this.database.exec("DELETE FROM _fake_celld_alarm");
    return Number(row.at);
  }

  /** Closes the file, as a stopped process would. */
  closeFile(): void {
    this.database.close();
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /** Resets the object now, as celld does when a transaction passes its limit. */
  induceReset(): void {
    this.resetOpenTransaction?.();
  }

  async transaction<T>(closure: (transaction: CelldStorage) => Promise<T>): Promise<T> {
    this.assertLive();
    const savepoint = `cells_tx_${++this.savepoints}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    const { promise: reset, reject: rejectReset } = Promise.withResolvers<never>();
    let finished = false;
    const resetNow = () => {
      if (finished) return;
      finished = true;
      this.database.exec(`ROLLBACK TO ${savepoint}`);
      this.database.exec(`RELEASE ${savepoint}`);
      this.aborted = true;
      rejectReset(new Error(RESET_MESSAGE));
    };
    this.resetOpenTransaction = resetNow;
    const timer = setTimeout(resetNow, this.transactionLimitMs);
    try {
      const value = await Promise.race([closure(this), reset]);
      if (finished) throw new Error(RESET_MESSAGE);
      finished = true;
      this.database.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      if (!finished) {
        finished = true;
        try {
          if (this.failNextRollback) {
            this.failNextRollback = false;
            throw new Error("disk I/O error during rollback");
          }
          this.database.exec(`ROLLBACK TO ${savepoint}`);
          this.database.exec(`RELEASE ${savepoint}`);
        } catch {
          // celld aborts the object and rethrows the callback's error (_abortAfterFailedRollback).
          this.aborted = true;
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.resetOpenTransaction = undefined;
    }
  }

  async deleteAll(): Promise<void> {
    this.assertLive();
    const tables = this.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_fake_celld_alarm'",
      )
      .all() as { name: string }[];
    for (const { name } of tables) this.database.exec(`DROP TABLE "${name}"`);
  }

  private exec(query: string, bindings: CelldSqlBinding[]): CelldSqlCursor {
    this.assertLive();
    this.statements.push(query);
    const statement = this.database.prepare(query);
    if (bindings.length === 0 && statement.columns().length === 0) {
      this.database.exec(query);
      return new FakeCursor([]);
    }
    const rows = statement.all(...(bindings as SQLInputValue[])) as CelldSqlRow[];
    return new FakeCursor(rows.map((row) => ({ ...row })));
  }

  private assertLive(): void {
    if (this.aborted)
      throw new Error("the Durable Object was reset; this event's storage is closed");
  }
}
