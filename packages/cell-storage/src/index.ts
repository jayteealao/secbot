import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CelldSqliteDatabase, type CelldSqliteDatabaseOptions } from "./celld-sqlite-database.ts";
import type { CelldStorage } from "./celld-types.ts";

export { CellSnapshots, type SnapshotHost } from "./cell-snapshots.ts";
export {
  ADAPTER_NAME,
  CELLD_TRANSACTION_LIMIT_MS,
  CelldSqliteDatabase,
  type CelldSqliteDatabaseOptions,
  CellStorageClosedError,
  CellStorageTransactionTimeout,
  RETIRED_INPUT_GATE,
} from "./celld-sqlite-database.ts";
export type {
  CelldAlarmInfo,
  CelldAlarmStorage,
  CelldCellStorage,
  CelldSqlBinding,
  CelldSqlCursor,
  CelldSqlRow,
  CelldSqlStorage,
  CelldStorage,
} from "./celld-types.ts";
export { needsReopen, POISONED_SESSION } from "./reopen.ts";
export {
  type CellDump,
  type DumpSchemaEntry,
  type DumpTable,
  type DumpValue,
  databaseRunner,
  digestCell,
  digestTables,
  dumpCell,
  loadCell,
  SNAPSHOT_FORMAT,
  SnapshotDigestMismatch,
  type SnapshotRunner,
  type SnapshotSql,
  storageRunner,
  type TransactionalDatabase,
  wipeCell,
} from "./snapshot.ts";

/** Opens pi-durable storage on a celld object's `ctx.storage`. */
export function openCelldStorage(
  storage: CelldStorage,
  options?: CelldSqliteDatabaseOptions,
): Promise<SqliteStorage> {
  return SqliteStorage.open(new CelldSqliteDatabase(storage, options));
}

/**
 * Opens pi-durable storage and returns the driver with it, so the cell's own tables (the household
 * change log) run through the same operation queue as pi-durable and never join one of its open
 * transactions.
 */
export async function openCelldStorageWithDatabase(
  storage: CelldStorage,
  options?: CelldSqliteDatabaseOptions,
): Promise<{ readonly storage: SqliteStorage; readonly database: CelldSqliteDatabase }> {
  const database = new CelldSqliteDatabase(storage, options);
  return { storage: await SqliteStorage.open(database), database };
}
