import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { StorageRejected } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_NAME,
  CelldSqliteDatabase,
  CellStorageClosedError,
  CellStorageTransactionTimeout,
  needsReopen,
  openCelldStorage,
  POISONED_SESSION,
} from "../src/index.ts";
import { FakeCelldStorage, RETIRED_INPUT_GATE_MESSAGE } from "./fake-celld-storage.ts";

type CountRow = { n: number };

const setup = async (options: { transactionLimitMs?: number } = {}) => {
  const storage = new FakeCelldStorage(options);
  const lines: string[] = [];
  const database = new CelldSqliteDatabase(storage, { log: (line) => lines.push(line) });
  await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
  return { storage, database, lines };
};

const count = async (database: CelldSqliteDatabase) =>
  (await database.get<CountRow>("SELECT count(*) AS n FROM items"))?.n;

describe("CelldSqliteDatabase", () => {
  it("names itself so a conformance run can prove which driver ran", async () => {
    const { database } = await setup();
    expect(database.adapter).toBe(ADAPTER_NAME);
    expect(ADAPTER_NAME).toBe("CelldSqliteDatabase");
  });

  it("runs exec, run, get, and all on the cell's SQL storage", async () => {
    const { database } = await setup();
    await database.run("INSERT INTO items (id, label) VALUES (?, ?)", 1, "milk");
    await database.run("INSERT INTO items (id, label) VALUES (?, ?)", 2n, "bread");
    expect(await database.get("SELECT label FROM items WHERE id = ?", 2)).toEqual({
      label: "bread",
    });
    expect(await database.get("SELECT label FROM items WHERE id = ?", 9)).toBeUndefined();
    expect(await database.all("SELECT id FROM items ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("runs several statements in one exec", async () => {
    const { database } = await setup();
    await database.exec("CREATE TABLE a (x); CREATE TABLE b (y)");
    expect(
      await database.all("SELECT name FROM sqlite_master WHERE name IN ('a', 'b') ORDER BY name"),
    ).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("refuses a bigint binding outside the safe integer range", async () => {
    const { database } = await setup();
    await expect(database.run("INSERT INTO items (id) VALUES (?)", 2n ** 60n)).rejects.toThrow(
      RangeError,
    );
  });

  it("reads write cursors to their end (RETURNING)", async () => {
    const { database } = await setup();
    const rows = await database.all<{ id: number }>(
      "INSERT INTO items (id, label) VALUES (5, 'x') RETURNING id",
    );
    expect(rows).toEqual([{ id: 5 }]);
  });

  // An operation that arrives while a transaction is open waits for it.
  it("queues an operation from the same event until the open transaction ends", async () => {
    const { storage, database } = await setup();
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    const order: string[] = [];
    const transaction = database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id, label) VALUES (1, 'inside')");
      order.push("tx wrote");
      await gate;
      order.push("tx ends");
      throw new Error("abandon");
    });
    const outside = database.run("INSERT INTO items (id, label) VALUES (2, 'outside')").then(() => {
      order.push("outside wrote");
    });
    const read = count(database).then((n) => {
      order.push(`read ${n}`);
      return n;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["tx wrote"]);
    openGate();
    await expect(transaction).rejects.toThrow("abandon");
    await outside;
    // The outside write did not join the rolled-back transaction, so it survives.
    expect(await read).toBe(1);
    expect(order).toEqual(["tx wrote", "tx ends", "outside wrote", "read 1"]);
    expect(await database.all("SELECT label FROM items")).toEqual([{ label: "outside" }]);
    expect(storage.statements.filter((sql) => sql.includes("outside"))).toHaveLength(1);
  });

  it("queues a second transaction behind the first", async () => {
    const { database } = await setup();
    const order: string[] = [];
    const first = database.transaction(async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tx.run("INSERT INTO items (id) VALUES (1)");
      order.push("first");
    });
    const second = database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id) VALUES (2)");
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(await count(database)).toBe(2);
  });

  it("commits and returns the callback value", async () => {
    const { database } = await setup();
    const value = await database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id) VALUES (1)");
      return (await tx.get<CountRow>("SELECT count(*) AS n FROM items"))?.n;
    });
    expect(value).toBe(1);
    expect(await count(database)).toBe(1);
  });

  it("rolls back and rejects with the same error when the callback rejects", async () => {
    const { database } = await setup();
    const failure = new Error("callback failed");
    const result = database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id) VALUES (1)");
      throw failure;
    });
    await expect(result).rejects.toBe(failure);
    expect(await count(database)).toBe(0);
  });

  it("rejects with an AggregateError when the rollback fails", async () => {
    const { storage, database } = await setup();
    storage.failNextRollback = true;
    const failure = new Error("callback failed");
    const result = database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id) VALUES (1)");
      throw failure;
    });
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(failure);
    await expect(database.run("INSERT INTO items (id) VALUES (2)")).rejects.toBeInstanceOf(
      CellStorageClosedError,
    );
  });

  it("stops a transaction handle once the transaction has settled", async () => {
    const { database } = await setup();
    let kept: Parameters<Parameters<CelldSqliteDatabase["transaction"]>[0]>[0] | undefined;
    await database.transaction(async (tx) => {
      kept = tx;
    });
    await expect(kept?.run("INSERT INTO items (id) VALUES (1)")).rejects.toThrow(
      "no longer active",
    );
  });

  // A transaction past the limit reports an error and leaves no partial write.
  it("maps celld's transaction reset to CellStorageTransactionTimeout with no partial write", async () => {
    const { storage, database, lines } = await setup({ transactionLimitMs: 40 });
    await database.run("INSERT INTO items (id, label) VALUES (1, 'before')");
    const result = database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id, label) VALUES (2, 'marker')");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.run("INSERT INTO items (id, label) VALUES (3, 'late')");
    });
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CellStorageTransactionTimeout);
    expect((error as CellStorageTransactionTimeout).durationMs).toBeGreaterThanOrEqual(30);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "cell_storage.transaction_timeout",
    });
    // The driver is closed; the cell opens a new one on its next event.
    await expect(database.run("SELECT 1")).rejects.toBeInstanceOf(CellStorageClosedError);
    // No row from the timed-out transaction is visible.
    const rows = storage.database.prepare("SELECT label FROM items ORDER BY id").all();
    expect(rows.map((row) => ({ ...row }))).toEqual([{ label: "before" }]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(storage.database.prepare("SELECT count(*) AS n FROM items").get()).toMatchObject({
      n: 1,
    });
  });

  it("maps an induced reset the same way", async () => {
    const { storage, database } = await setup();
    const result = database.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id) VALUES (1)");
      storage.induceReset();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await expect(result).rejects.toBeInstanceOf(CellStorageTransactionTimeout);
  });

  it("reports a gate celld refused before the callback ran as StorageRejected, so pi-durable does not poison its session", async () => {
    const { storage, database } = await setup();
    storage.refuseNextGate = true;
    let ran = false;
    const error = await database
      .transaction(async (tx) => {
        ran = true;
        await tx.run("INSERT INTO items (id) VALUES (1)");
      })
      .catch((caught: unknown) => caught);
    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(StorageRejected);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe(RETIRED_INPUT_GATE_MESSAGE);
    // The driver stays open: the next transaction commits.
    await database.transaction((tx) => tx.run("INSERT INTO items (id) VALUES (2)"));
    expect(await count(database)).toBe(1);
  });

  it("keeps a callback's own error unchanged when the callback ran", async () => {
    const { database } = await setup();
    const failure = new Error(RETIRED_INPUT_GATE_MESSAGE);
    const error = await database
      .transaction(async (tx) => {
        await tx.run("INSERT INTO items (id) VALUES (1)");
        throw failure;
      })
      .catch((caught: unknown) => caught);
    expect(error).toBe(failure);
    expect(await count(database)).toBe(0);
  });

  it("tells a poisoned session, a closed driver, or a closed cell database from any other error", () => {
    const poisoned = new Error(`${POISONED_SESSION}; reopen it`);
    expect(needsReopen(poisoned)).toBe(true);
    expect(needsReopen(new Error("wrapped", { cause: poisoned }))).toBe(true);
    expect(needsReopen(new CellStorageClosedError("close() was called"))).toBe(true);
    // celld after it gave the cell back: SQL calls and storage calls both name the scope.
    expect(needsReopen(new Error("SQL error: no db for PersonCell:abc123"))).toBe(true);
    expect(needsReopen(new Error("storage.get: no db for PersonCell:abc123"))).toBe(true);
    expect(needsReopen(new Error("wrapped", { cause: new Error("no db for X:1") }))).toBe(true);
    expect(needsReopen(new Error("no db found"))).toBe(false);
    expect(needsReopen(new Error("the model is down"))).toBe(false);
    expect(needsReopen("Session is poisoned")).toBe(false);
    expect(needsReopen(undefined)).toBe(false);
  });

  it("refuses every operation after close", async () => {
    const { database } = await setup();
    await database.close();
    await database.close();
    await expect(database.get("SELECT 1")).rejects.toBeInstanceOf(CellStorageClosedError);
    await expect(database.transaction(async () => undefined)).rejects.toBeInstanceOf(
      CellStorageClosedError,
    );
  });

  it("opens pi-durable storage through openCelldStorage", async () => {
    const storage = new FakeCelldStorage();
    const durable = await openCelldStorage(storage, { log: () => {} });
    const tables = storage.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'durable_metadata'")
      .all();
    expect(tables).toHaveLength(1);
    await durable.close(BACKGROUND_CONTEXT);
  });

  it("logs to console.error by default", async () => {
    const storage = new FakeCelldStorage({ transactionLimitMs: 5 });
    const database = new CelldSqliteDatabase(storage);
    const original = console.error;
    const lines: unknown[] = [];
    console.error = (line: unknown) => lines.push(line);
    try {
      await database
        .transaction(() => new Promise((resolve) => setTimeout(resolve, 50)))
        .catch(() => undefined);
    } finally {
      console.error = original;
    }
    expect(String(lines[0])).toContain("cell_storage.transaction_timeout");
  });
});
