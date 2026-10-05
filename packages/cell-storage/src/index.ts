import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CelldSqliteDatabase, type CelldSqliteDatabaseOptions } from "./celld-sqlite-database.ts";
import type { CelldStorage } from "./celld-types.ts";

export {
  ADAPTER_NAME,
  CELLD_TRANSACTION_LIMIT_MS,
  CelldSqliteDatabase,
  type CelldSqliteDatabaseOptions,
  CellStorageClosedError,
  CellStorageTransactionTimeout,
} from "./celld-sqlite-database.ts";
export type {
  CelldSqlBinding,
  CelldSqlCursor,
  CelldSqlRow,
  CelldSqlStorage,
  CelldStorage,
} from "./celld-types.ts";

/** Opens pi-durable storage on a celld object's `ctx.storage`. */
export function openCelldStorage(
  storage: CelldStorage,
  options?: CelldSqliteDatabaseOptions,
): Promise<SqliteStorage> {
  return SqliteStorage.open(new CelldSqliteDatabase(storage, options));
}
