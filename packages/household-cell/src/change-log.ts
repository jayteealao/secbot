/**
 * The household change log: each document is its live items plus an ordered log of single-item
 * changes keyed by a unique operation id (per-item merge, chosen by the owner in shaping).
 *
 * - One change applies in one transaction through the cell's `CelldSqliteDatabase`, the same
 *   operation queue pi-durable uses, so it never joins one of pi-durable's open transactions.
 * - A repeated operation id returns the stored result and changes nothing: SQLite `UNIQUE` on
 *   `op_id`. celld retries an RPC only when the method never started (source:
 *   .scratch/sources/git/celld tag v0.6.1, docs/cloudflare-compat.md:95-99), so this id is what
 *   stops a client retry after a lost response from applying twice.
 * - Changes to different items both land. For the same item, the later entry in the log wins;
 *   both entries stay in the log. "Later" is the household cell's own order of arrival: one
 *   Durable Object serializes every change, and no device clock decides.
 */
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import {
  CELL_NAME,
  HOUSEHOLD_DOCUMENT,
  type HouseholdApplyResult,
  type HouseholdChange,
  type HouseholdDocument,
  type HouseholdItem,
} from "@secbot/cell-harness";

export const ITEM_TEXT_LIMIT = 500;
const OP_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS household_items (
  document TEXT NOT NULL,
  item_id TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document, item_id)
);
CREATE TABLE IF NOT EXISTS household_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  document TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  from_cell TEXT NOT NULL,
  at INTEGER NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS household_changes_item ON household_changes (document, item_id, seq);
`;

/** The error name a refused change carries across RPC and HTTP. */
export const REFUSED_HOUSEHOLD_CHANGE = "RefusedHouseholdChange";

/** A change the household cell refuses; the message names the field, never a value. */
export class RefusedHouseholdChange extends Error {
  constructor(message: string) {
    super(message);
    this.name = REFUSED_HOUSEHOLD_CHANGE;
  }
}

/**
 * True for a refused change, also one that crossed RPC (where only the name survives), so a caller
 * answers it as a bad request instead of a failure to retry.
 */
export function isRefusedHouseholdChange(error: unknown): boolean {
  return error instanceof Error && error.name === REFUSED_HOUSEHOLD_CHANGE;
}

export interface HistoryEntry {
  readonly seq: number;
  readonly opId: string;
  readonly itemId: string;
  readonly kind: HouseholdChange["kind"];
  readonly fromCell: string;
  readonly at: number;
  readonly payload: { readonly text?: string; readonly done?: boolean };
  readonly outcome: HouseholdApplyResult["outcome"];
}

type ItemRow = {
  item_id: string;
  text: string;
  done: number;
  version: number;
  updated_seq: number;
};

const itemOf = (row: ItemRow): HouseholdItem => ({
  itemId: row.item_id,
  text: row.text,
  done: Number(row.done) === 1,
  version: Number(row.version),
  updatedSeq: Number(row.updated_seq),
});

/** Checks a change that arrived over RPC; returns it narrowed or throws `RefusedHouseholdChange`. */
export function validateChange(change: unknown): HouseholdChange {
  const value = change as Record<string, unknown> | null;
  if (value === null || typeof value !== "object") throw new RefusedHouseholdChange("no change");
  const { opId, document, fromCell, kind } = value;
  if (typeof opId !== "string" || !OP_ID.test(opId)) {
    throw new RefusedHouseholdChange("bad operation id");
  }
  if (typeof document !== "string" || !HOUSEHOLD_DOCUMENT.test(document)) {
    throw new RefusedHouseholdChange("bad document name");
  }
  if (typeof fromCell !== "string" || !CELL_NAME.test(fromCell)) {
    throw new RefusedHouseholdChange("bad cell name");
  }
  const goodText = (text: unknown): text is string =>
    typeof text === "string" && text.trim() !== "" && text.length <= ITEM_TEXT_LIMIT;
  if (kind === "add") {
    if (!goodText(value.text)) throw new RefusedHouseholdChange("bad item text");
    return { opId, document, fromCell, kind, text: value.text };
  }
  const itemId = value.itemId;
  if (typeof itemId !== "string" || !OP_ID.test(itemId)) {
    throw new RefusedHouseholdChange("bad item id");
  }
  if (kind === "remove") return { opId, document, fromCell, kind, itemId };
  if (kind !== "edit") throw new RefusedHouseholdChange("bad change kind");
  if (value.text !== undefined && !goodText(value.text)) {
    throw new RefusedHouseholdChange("bad item text");
  }
  if (value.done !== undefined && typeof value.done !== "boolean") {
    throw new RefusedHouseholdChange("bad done mark");
  }
  if (value.text === undefined && value.done === undefined) {
    throw new RefusedHouseholdChange("an edit needs a text or a done mark");
  }
  return {
    opId,
    document,
    fromCell,
    kind,
    itemId,
    ...(value.text === undefined ? {} : { text: value.text as string }),
    ...(value.done === undefined ? {} : { done: value.done as boolean }),
  };
}

export class ChangeLog {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.database.exec(SCHEMA).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /** Applies one change once per operation id. */
  async apply(input: HouseholdChange): Promise<HouseholdApplyResult> {
    const change = validateChange(input);
    await this.init();
    return this.database.transaction(async (tx) => {
      const prior = await tx.get<{ result: string }>(
        "SELECT result FROM household_changes WHERE op_id = ?",
        change.opId,
      );
      if (prior !== undefined) {
        return { ...(JSON.parse(prior.result) as HouseholdApplyResult), duplicate: true };
      }
      const itemId = change.kind === "add" ? change.opId : change.itemId;
      const payload =
        change.kind === "add"
          ? { text: change.text }
          : change.kind === "edit"
            ? {
                ...(change.text === undefined ? {} : { text: change.text }),
                ...(change.done === undefined ? {} : { done: change.done }),
              }
            : {};
      const inserted = await tx.get<{ seq: number }>(
        "INSERT INTO household_changes (op_id, document, item_id, kind, payload, from_cell, at, result) VALUES (?, ?, ?, ?, ?, ?, ?, '') RETURNING seq",
        change.opId,
        change.document,
        itemId,
        change.kind,
        JSON.stringify(payload),
        change.fromCell,
        this.now(),
      );
      const seq = Number(inserted?.seq);
      let outcome: HouseholdApplyResult["outcome"] = "applied";
      if (change.kind === "add") {
        await tx.run(
          "INSERT INTO household_items (document, item_id, text, done, version, created_seq, updated_seq, removed) VALUES (?, ?, ?, 0, 1, ?, ?, 0)",
          change.document,
          itemId,
          change.text,
          seq,
          seq,
        );
      } else {
        const live = await tx.get<ItemRow>(
          "SELECT item_id, text, done, version, updated_seq FROM household_items WHERE document = ? AND item_id = ? AND removed = 0",
          change.document,
          itemId,
        );
        if (live === undefined) {
          outcome = "missing";
        } else if (change.kind === "remove") {
          await tx.run(
            "UPDATE household_items SET removed = 1, version = version + 1, updated_seq = ? WHERE document = ? AND item_id = ?",
            seq,
            change.document,
            itemId,
          );
        } else {
          await tx.run(
            "UPDATE household_items SET text = ?, done = ?, version = version + 1, updated_seq = ? WHERE document = ? AND item_id = ?",
            change.text ?? live.text,
            change.done === undefined ? Number(live.done) : change.done ? 1 : 0,
            seq,
            change.document,
            itemId,
          );
        }
      }
      const result: HouseholdApplyResult = {
        outcome,
        kind: change.kind,
        itemId,
        seq,
        duplicate: false,
      };
      await tx.run(
        "UPDATE household_changes SET result = ? WHERE seq = ?",
        JSON.stringify(result),
        seq,
      );
      return result;
    });
  }

  /** The document's live items, oldest first. */
  async read(document: string): Promise<HouseholdDocument> {
    if (!HOUSEHOLD_DOCUMENT.test(document)) throw new RefusedHouseholdChange("bad document name");
    await this.init();
    const rows = await this.database.all<ItemRow>(
      "SELECT item_id, text, done, version, updated_seq FROM household_items WHERE document = ? AND removed = 0 ORDER BY created_seq",
      document,
    );
    return { document, items: rows.map(itemOf) };
  }

  /** The document's changes in log order, or one item's. */
  async history(document: string, itemId?: string): Promise<HistoryEntry[]> {
    await this.init();
    const rows = await this.database.all<{
      seq: number;
      op_id: string;
      item_id: string;
      kind: HouseholdChange["kind"];
      from_cell: string;
      at: number;
      payload: string;
      result: string;
    }>(
      itemId === undefined
        ? "SELECT seq, op_id, item_id, kind, from_cell, at, payload, result FROM household_changes WHERE document = ? ORDER BY seq"
        : "SELECT seq, op_id, item_id, kind, from_cell, at, payload, result FROM household_changes WHERE document = ? AND item_id = ? ORDER BY seq",
      ...(itemId === undefined ? [document] : [document, itemId]),
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      opId: row.op_id,
      itemId: row.item_id,
      kind: row.kind,
      fromCell: row.from_cell,
      at: Number(row.at),
      payload: JSON.parse(row.payload) as HistoryEntry["payload"],
      outcome: (JSON.parse(row.result) as HouseholdApplyResult).outcome,
    }));
  }
}
