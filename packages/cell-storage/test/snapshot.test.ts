// Whole-database snapshots on the node:sqlite stand-in: a pi-durable database dumps and loads into
// a fresh cell with an equal digest, BLOBs round-trip, a tampered dump is refused with nothing
// changed, a load that fails half way leaves no partial table, and a wipe leaves no app table.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import {
  type CellDump,
  CelldSqliteDatabase,
  databaseRunner,
  digestCell,
  dumpCell,
  loadCell,
  openCelldStorage,
  SnapshotDigestMismatch,
  storageRunner,
  wipeCell,
} from "../src/index.ts";
import { FakeCelldStorage } from "./fake-celld-storage.ts";

const appTables = (storage: FakeCelldStorage) =>
  (
    storage.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND substr(name, 1, 1) != '_' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

async function seededCell(): Promise<FakeCelldStorage> {
  const storage = new FakeCelldStorage();
  const durable = await openCelldStorage(storage);
  await durable.close(BACKGROUND_CONTEXT);
  storage.sql
    .exec(
      "CREATE TABLE household_items (item_id TEXT PRIMARY KEY, text TEXT NOT NULL, photo BLOB, n INTEGER)",
    )
    .toArray();
  storage.sql.exec("CREATE INDEX household_items_text ON household_items (text)").toArray();
  storage.sql
    .exec(
      "INSERT INTO household_items VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
      "a",
      "milk",
      new Uint8Array([0, 1, 254, 255]),
      2,
      "b",
      "bread",
      null,
      1,
    )
    .toArray();
  await storage.setAlarm(1_900_000_000_000);
  return storage;
}

describe("cell snapshots", () => {
  it("dumps a pi-durable database and loads it into a fresh cell with the same digest", async () => {
    const source = await seededCell();
    const dump = await dumpCell(storageRunner(source), { contractStep: 3, now: () => 42 });
    expect(dump.format).toBe(1);
    expect(dump.contractStep).toBe(3);
    expect(dump.takenAt).toBe(42);
    expect(Object.keys(dump.tables)).toEqual(
      expect.arrayContaining(["durable_schema", "household_items"]),
    );
    expect(Object.keys(dump.tables).some((name) => name.startsWith("_"))).toBe(false);
    expect(dump.schema.some((entry) => entry.name === "household_items_text")).toBe(true);
    // The dump is plain JSON (it travels to the bucket as an object).
    const copy = JSON.parse(JSON.stringify(dump)) as CellDump;

    const target = new FakeCelldStorage();
    target.sql.exec("CREATE TABLE stale (x)").toArray();
    const loaded = await loadCell(storageRunner(target), copy);
    expect(loaded.digest).toBe(dump.digest);
    expect(loaded.rows).toBe(dump.rows);
    expect(appTables(target)).toEqual(appTables(source));
    expect((await digestCell(storageRunner(target))).digest).toBe(dump.digest);
    const photo = target.database
      .prepare("SELECT photo FROM household_items WHERE item_id = 'a'")
      .get() as { photo: Uint8Array };
    expect([...photo.photo]).toEqual([0, 1, 254, 255]);
    // pi-durable opens the restored database.
    const reopened = await openCelldStorage(target);
    await reopened.close(BACKGROUND_CONTEXT);
  });

  it("runs through the storage driver's queue when the harness is open", async () => {
    const source = await seededCell();
    const database = new CelldSqliteDatabase(source);
    const viaDriver = await dumpCell(databaseRunner(database), { contractStep: 3 });
    const direct = await dumpCell(storageRunner(source), { contractStep: 3 });
    expect(viaDriver.digest).toBe(direct.digest);
  });

  it("refuses a tampered dump and leaves the cell as it was", async () => {
    const source = await seededCell();
    const dump = await dumpCell(storageRunner(source), { contractStep: 3 });
    const tampered: CellDump = {
      ...dump,
      tables: {
        ...dump.tables,
        household_items: {
          columns: dump.tables.household_items?.columns ?? [],
          rows: [["a", "beer", null, 9]],
        },
      },
    };
    const target = await seededCell();
    const before = await digestCell(storageRunner(target));
    await expect(loadCell(storageRunner(target), tampered)).rejects.toBeInstanceOf(
      SnapshotDigestMismatch,
    );
    expect(await digestCell(storageRunner(target))).toEqual(before);
  });

  it("rolls a load back when a statement fails half way, with no partial table visible", async () => {
    const source = await seededCell();
    const dump = await dumpCell(storageRunner(source), { contractStep: 3 });
    const broken: CellDump = {
      ...dump,
      schema: [
        ...dump.schema,
        { type: "index", name: "broken", sql: "CREATE INDEX broken ON nope (x)" },
      ],
    };
    const target = new FakeCelldStorage();
    target.sql.exec("CREATE TABLE keep (x)").toArray();
    await expect(loadCell(storageRunner(target), broken)).rejects.toThrow();
    expect(appTables(target)).toEqual(["keep"]);
  });

  it("wipes every app table and keeps the cell's alarm", async () => {
    const storage = await seededCell();
    await wipeCell(storageRunner(storage));
    expect(appTables(storage)).toEqual([]);
    expect(await storage.getAlarm()).toBe(1_900_000_000_000);
    expect((await digestCell(storageRunner(storage))).rows).toBe(0);
  });

  it("refuses a dump of another format", async () => {
    const storage = new FakeCelldStorage();
    const dump = await dumpCell(storageRunner(storage), { contractStep: 3 });
    await expect(
      loadCell(storageRunner(storage), { ...dump, format: 2 } as unknown as CellDump),
    ).rejects.toThrow("snapshot format 2 is not 1");
  });
});
