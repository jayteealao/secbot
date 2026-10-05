/**
 * The part of celld's Durable Object storage (`ctx.storage`) that the adapter uses.
 *
 * Structural types, written from celld v0.6.1 `crates/celld/js/harness.js`
 * (classes `SqlCursor`, `SqlStorage`, `DurableObjectStorage`), which mirror Cloudflare's
 * `SqlStorage` API. Only the members the adapter calls are listed.
 */

/** A value celld's `sql.exec` accepts as a positional binding. */
export type CelldSqlBinding = null | number | string | Uint8Array;

/** A row as celld returns it: column name to value. */
export type CelldSqlRow = Record<string, unknown>;

/** One `sql.exec` result. A write cursor must be read to its end before the event responds. */
export interface CelldSqlCursor extends Iterable<CelldSqlRow> {
  toArray(): CelldSqlRow[];
}

export interface CelldSqlStorage {
  /** Runs one or more statements; bindings apply to the statement that takes them. */
  exec(query: string, ...bindings: CelldSqlBinding[]): CelldSqlCursor;
}

export interface CelldStorage {
  readonly sql: CelldSqlStorage;
  /**
   * Runs `closure` inside a transaction. The closure receives a transaction view of the
   * storage; its SQL runs inside the transaction. A rejected closure rolls back.
   */
  transaction<T>(closure: (transaction: CelldStorage) => Promise<T>): Promise<T>;
  /** Deletes every key and table of the object. */
  deleteAll(): Promise<void>;
}
