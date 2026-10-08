// The household change log. Two changes to different items at once both land; two changes
// to the same item: the later wins and both stay in the history. The same operation id
// twice applies once and returns the same result.
import { describe, expect, it } from "vitest";
import { CelldSqliteDatabase } from "../../cell-storage/src/index.ts";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { ChangeLog, RefusedHouseholdChange, validateChange } from "../src/change-log.ts";

const open = () => {
  const storage = new FakeCelldStorage();
  return { storage, log: new ChangeLog(new CelldSqliteDatabase(storage), () => 1_000) };
};

const add = (opId: string, text: string, fromCell = "owner") =>
  ({ opId, document: "list", fromCell, kind: "add", text }) as const;

describe("household change log", () => {
  it("lands two changes to different items made at the same time", async () => {
    const { log } = open();
    await log.apply(add("op-milk", "milk"));
    await log.apply(add("op-eggs", "eggs"));
    const [a, b] = await Promise.all([
      log.apply({
        opId: "op-1",
        document: "list",
        fromCell: "owner",
        kind: "edit",
        itemId: "op-milk",
        done: true,
      }),
      log.apply({
        opId: "op-2",
        document: "list",
        fromCell: "second",
        kind: "edit",
        itemId: "op-eggs",
        text: "6 eggs",
      }),
    ]);
    expect([a.outcome, b.outcome]).toEqual(["applied", "applied"]);
    const { items } = await log.read("list");
    expect(items.map((item) => [item.itemId, item.text, item.done])).toEqual([
      ["op-milk", "milk", true],
      ["op-eggs", "6 eggs", false],
    ]);
  });

  it("lets the later change to the same item win and keeps both in the history", async () => {
    const { log } = open();
    await log.apply(add("op-bread", "bread"));
    const [first, second] = await Promise.all([
      log.apply({
        opId: "op-a",
        document: "list",
        fromCell: "owner",
        kind: "edit",
        itemId: "op-bread",
        text: "white bread",
      }),
      log.apply({
        opId: "op-b",
        document: "list",
        fromCell: "second",
        kind: "edit",
        itemId: "op-bread",
        text: "brown bread",
      }),
    ]);
    expect(second.seq).toBeGreaterThan(first.seq);
    const { items } = await log.read("list");
    expect(items).toEqual([
      { itemId: "op-bread", text: "brown bread", done: false, version: 3, updatedSeq: second.seq },
    ]);
    const history = await log.history("list", "op-bread");
    expect(history.map((entry) => [entry.kind, entry.fromCell, entry.payload.text])).toEqual([
      ["add", "owner", "bread"],
      ["edit", "owner", "white bread"],
      ["edit", "second", "brown bread"],
    ]);
  });

  it("applies a repeated operation id once and returns the stored result", async () => {
    const { log, storage } = open();
    const first = await log.apply(add("owner:12:call-1", "apples"));
    const again = await log.apply(add("owner:12:call-1", "apples"));
    expect(first).toMatchObject({
      outcome: "applied",
      duplicate: false,
      itemId: "owner:12:call-1",
    });
    expect(again).toEqual({ ...first, duplicate: true });
    expect((await log.read("list")).items).toHaveLength(1);
    expect(await log.history("list")).toHaveLength(1);
    const removed = {
      opId: "rm-1",
      document: "list",
      fromCell: "second",
      kind: "remove",
      itemId: "owner:12:call-1",
    } as const;
    await log.apply(removed);
    await log.apply(removed);
    expect((await log.read("list")).items).toHaveLength(0);
    const rows = storage.database.prepare("SELECT count(*) AS n FROM household_changes").get() as {
      n: number;
    };
    expect(Number(rows.n)).toBe(2);
  });

  it("records an edit or remove of a missing item as missing, without failing", async () => {
    const { log } = open();
    const edit = await log.apply({
      opId: "e-1",
      document: "list",
      fromCell: "owner",
      kind: "edit",
      itemId: "nope",
      done: true,
    });
    expect(edit).toMatchObject({ outcome: "missing", itemId: "nope" });
    await log.apply(add("x-1", "soap"));
    await log.apply({
      opId: "r-1",
      document: "list",
      fromCell: "owner",
      kind: "remove",
      itemId: "x-1",
    });
    const late = await log.apply({
      opId: "e-2",
      document: "list",
      fromCell: "second",
      kind: "edit",
      itemId: "x-1",
      text: "soap bars",
    });
    expect(late.outcome).toBe("missing");
    expect((await log.history("list", "x-1")).map((entry) => entry.outcome)).toEqual([
      "applied",
      "applied",
      "missing",
    ]);
  });

  it("refuses a malformed change from RPC", () => {
    const bad: unknown[] = [
      null,
      { opId: "", document: "list", fromCell: "owner", kind: "add", text: "x" },
      { opId: "a b", document: "list", fromCell: "owner", kind: "add", text: "x" },
      { opId: "a", document: "List", fromCell: "owner", kind: "add", text: "x" },
      { opId: "a", document: "list", fromCell: "Owner", kind: "add", text: "x" },
      { opId: "a", document: "list", fromCell: "owner", kind: "add", text: " " },
      { opId: "a", document: "list", fromCell: "owner", kind: "add", text: "x".repeat(501) },
      { opId: "a", document: "list", fromCell: "owner", kind: "edit", itemId: "i" },
      { opId: "a", document: "list", fromCell: "owner", kind: "edit", itemId: "i", done: "yes" },
      { opId: "a", document: "list", fromCell: "owner", kind: "drop", itemId: "i" },
      { opId: "a", document: "list", fromCell: "owner", kind: "remove" },
    ];
    for (const change of bad) expect(() => validateChange(change)).toThrow(RefusedHouseholdChange);
  });
});
