/**
 * Whole-database snapshots of one cell: dump, load, digest, wipe.
 *
 * celld v0.6.1 has no cell export or point-in-time restore command (its docs list `cell list` and
 * `cell gc` only; source: .scratch/sources/git/celld tag v0.6.1, docs/README.md), so a cell dumps
 * its own tables. Each operation runs inside one storage transaction, so a dump is consistent and
 * a load is all or nothing: celld runs `transaction(f)` under `blockConcurrencyWhile`, and a
 * rejected callback rolls back (crates/celld/js/harness.js:1898-2006).
 *
 * Tables whose name starts with `_` or `sqlite_` are never touched: celld reserves `_cf_*` and the
 * replicator's `_litestream_*` tables and denies application SQL on them
 * (crates/celld/storage.rs:470-482, crates/ltx/src/db.rs:367-369); `sqlite_*` are SQLite's own.
 * Reading `sqlite_master` is allowed (storage.rs:544-676 denies only pragmas, transactions,
 * savepoints, ATTACH, temp objects, and reserved names).
 */
import type { CelldSqlBinding, CelldSqlRow, CelldStorage } from "./celld-types.ts";

/** Dump layout version; a load refuses any other. */
export const SNAPSHOT_FORMAT = 1;

/** A stored value: BLOBs travel as base64, so the dump is plain JSON. */
export type DumpValue = null | number | string | { readonly $b64: string };

export interface DumpSchemaEntry {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

export interface DumpTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly DumpValue[])[];
}

export interface CellDump {
  readonly format: typeof SNAPSHOT_FORMAT;
  /** The bundle's contract step when the dump was taken; restore refuses a later step. */
  readonly contractStep: number;
  readonly takenAt: number;
  readonly schema: readonly DumpSchemaEntry[];
  readonly tables: Readonly<Record<string, DumpTable>>;
  readonly rows: number;
  /** SHA-256 (hex) over every table's name and rows, independent of row order. */
  readonly digest: string;
}

/** The SQL a snapshot needs, inside one transaction. */
export interface SnapshotSql {
  all(query: string, ...params: CelldSqlBinding[]): Promise<CelldSqlRow[]>;
  run(query: string, ...params: CelldSqlBinding[]): Promise<void>;
}

/** Runs `work` inside one transaction of the cell's storage. */
export type SnapshotRunner = <T>(work: (sql: SnapshotSql) => Promise<T>) => Promise<T>;

/** The digest of a dump that does not match its rows. */
export class SnapshotDigestMismatch extends Error {
  constructor(expected: string, actual: string) {
    super(`snapshot digest mismatch: dump says ${expected}, rows give ${actual}`);
    this.name = "SnapshotDigestMismatch";
  }
}

/** A runner straight on `ctx.storage`, for a cell whose harness is closed. */
export const storageRunner =
  (storage: CelldStorage): SnapshotRunner =>
  (work) =>
    storage.transaction((view) =>
      work({
        all: async (query, ...params) => view.sql.exec(query, ...params).toArray(),
        run: async (query, ...params) => {
          // toArray() reads the cursor to its end: celld rejects a response while a write cursor is open.
          view.sql.exec(query, ...params).toArray();
        },
      }),
    );

/** Something that runs a transaction with async `all` and `run`, as the storage driver does. */
export interface TransactionalDatabase {
  transaction<T>(
    callback: (tx: {
      all<R extends object>(query: string, ...params: CelldSqlBinding[]): Promise<R[]>;
      run(query: string, ...params: CelldSqlBinding[]): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

/** A runner through the storage driver's queue, for a cell whose harness is open. */
export const databaseRunner =
  (database: TransactionalDatabase): SnapshotRunner =>
  (work) =>
    database.transaction((tx) =>
      work({
        all: (query, ...params) => tx.all<CelldSqlRow>(query, ...params),
        run: (query, ...params) => tx.run(query, ...params),
      }),
    );

const APP_OBJECTS = `SELECT type, name, tbl_name, sql FROM sqlite_master
  WHERE sql IS NOT NULL
    AND substr(name, 1, 1) != '_' AND substr(tbl_name, 1, 1) != '_'
    AND name NOT LIKE 'sqlite%' AND tbl_name NOT LIKE 'sqlite%'
  ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, rowid`;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function encodeValue(value: unknown): DumpValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return { $b64: toBase64(value) };
  if (value instanceof ArrayBuffer) return { $b64: toBase64(new Uint8Array(value)) };
  throw new TypeError(`snapshot: unsupported column value of type ${typeof value}`);
}

function decodeValue(value: DumpValue): CelldSqlBinding {
  if (value !== null && typeof value === "object") return fromBase64(value.$b64);
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 over every table's name, columns, and rows; rows sorted, so row order never matters. */
export function digestTables(tables: Readonly<Record<string, DumpTable>>): Promise<string> {
  const lines: string[] = [];
  for (const name of Object.keys(tables).sort()) {
    const table = tables[name];
    if (table === undefined) continue;
    lines.push(JSON.stringify(["table", name, table.columns]));
    lines.push(...table.rows.map((row) => JSON.stringify(row)).sort());
  }
  return sha256Hex(lines.join("\n"));
}

async function readTables(sql: SnapshotSql) {
  const objects = (await sql.all(APP_OBJECTS)).map((row) => ({
    type: String(row.type),
    name: String(row.name),
    sql: String(row.sql),
  }));
  const tables: Record<string, DumpTable> = {};
  let rows = 0;
  for (const object of objects) {
    if (object.type !== "table") continue;
    const records = await sql.all(`SELECT * FROM ${quote(object.name)}`);
    // celld allows `table_info` only with a literal table name it can judge at prepare time
    // (source: .scratch/sources/git/celld tag v0.6.1, crates/celld/storage.rs:533-534).
    const literal = `'${object.name.replaceAll("'", "''")}'`;
    const columns = (await sql.all(`SELECT name FROM pragma_table_info(${literal})`)).map((row) =>
      String(row.name),
    );
    tables[object.name] = {
      columns,
      rows: records.map((record) => columns.map((column) => encodeValue(record[column]))),
    };
    rows += records.length;
  }
  return { schema: objects, tables, rows };
}

/** Dumps every application table of the cell, with its schema and digest, in one transaction. */
export async function dumpCell(
  run: SnapshotRunner,
  options: { readonly contractStep: number; readonly now?: () => number },
): Promise<CellDump> {
  const { schema, tables, rows } = await run(readTables);
  return {
    format: SNAPSHOT_FORMAT,
    contractStep: options.contractStep,
    takenAt: (options.now ?? Date.now)(),
    schema,
    tables,
    rows,
    digest: await digestTables(tables),
  };
}

/** The digest and row count of the cell as it is now. */
export async function digestCell(run: SnapshotRunner): Promise<{ digest: string; rows: number }> {
  const { tables, rows } = await run(readTables);
  return { digest: await digestTables(tables), rows };
}

async function dropAll(sql: SnapshotSql): Promise<void> {
  const objects = await sql.all(APP_OBJECTS);
  // Views and triggers first, then tables (their indexes go with them).
  for (const type of ["view", "trigger", "table"]) {
    for (const object of objects.filter((row) => row.type === type)) {
      await sql.run(`DROP ${type.toUpperCase()} IF EXISTS ${quote(String(object.name))}`);
    }
  }
}

/** Drops every application table, view, index, and trigger of the cell, in one transaction. */
export function wipeCell(run: SnapshotRunner): Promise<void> {
  return run(dropAll);
}

/**
 * Replaces every application table with the dump's, in one transaction. The rows are read back
 * and digested before the commit; a mismatch rolls the whole load back.
 */
export async function loadCell(
  run: SnapshotRunner,
  dump: CellDump,
): Promise<{ digest: string; rows: number }> {
  if (dump.format !== SNAPSHOT_FORMAT) {
    throw new Error(`snapshot format ${String(dump.format)} is not ${SNAPSHOT_FORMAT}`);
  }
  const claimed = await digestTables(dump.tables);
  if (claimed !== dump.digest) throw new SnapshotDigestMismatch(dump.digest, claimed);
  return run(async (sql) => {
    await dropAll(sql);
    for (const entry of dump.schema.filter((item) => item.type === "table")) {
      await sql.run(entry.sql);
    }
    for (const [name, table] of Object.entries(dump.tables)) {
      if (table.columns.length === 0) continue;
      const columns = table.columns.map(quote).join(", ");
      const marks = table.columns.map(() => "?").join(", ");
      const insert = `INSERT INTO ${quote(name)} (${columns}) VALUES (${marks})`;
      for (const row of table.rows) await sql.run(insert, ...row.map(decodeValue));
    }
    for (const entry of dump.schema.filter((item) => item.type !== "table")) {
      await sql.run(entry.sql);
    }
    const loaded = await readTables(sql);
    const digest = await digestTables(loaded.tables);
    if (digest !== dump.digest) throw new SnapshotDigestMismatch(dump.digest, digest);
    return { digest, rows: loaded.rows };
  });
}
