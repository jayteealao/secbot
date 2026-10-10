// The operator routes on the node:sqlite stand-in, with an in-memory bucket in place of the
// SNAPSHOTS binding: the operator key gates every route; a snapshot writes one object per cell; a
// restore brings back the owner's conversation and the household list with an equal digest and
// re-arms the alarm; a dump from a later contract step, a missing snapshot, and the secrets cell
// are refused; a wipe empties; a fleet refuses another fleet's cell with the phrase.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CellHarness, openCellHarness } from "@secbot/cell-harness";
import {
  createFauxGateway,
  FakeCelldStorage,
  loggedEvents,
  until,
} from "@secbot/cell-harness/testing";
import type { CellDump } from "@secbot/cell-storage";
import { HouseholdCell } from "@secbot/household-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route, type WorkerEnv } from "../src/index.ts";
import { OPERATOR_HEADER } from "../src/internal-rpc.ts";
import type { SnapshotBucket } from "../src/ops.ts";
import { PERSON_HEADER, PersonCell } from "../src/person-cell.ts";

const KEY = "k".repeat(32);

class MemoryBucket implements SnapshotBucket {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
    return {};
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }
}

interface Setup {
  readonly env: WorkerEnv;
  readonly bucket: MemoryBucket;
  readonly storages: Map<string, FakeCelldStorage>;
  readonly opened: CellHarness[];
  readonly household: HouseholdCell;
  readonly cells: Map<string, PersonCell>;
}

const setups: Setup[] = [];
afterEach(async () => {
  for (const s of setups.splice(0)) {
    for (const cell of s.opened) await cell.close().catch(() => {});
    await s.household.close();
  }
  vi.restoreAllMocks();
});

function setup(extra: Partial<WorkerEnv> = {}): Setup {
  const gateway = createFauxGateway();
  const storages = new Map<string, FakeCelldStorage>();
  const opened: CellHarness[] = [];
  const cells = new Map<string, PersonCell>();
  const bucket = new MemoryBucket();
  const household = new HouseholdCell({ storage: new FakeCelldStorage() }, {}, { pollMs: 5 });
  const s = { bucket, storages, opened, household, cells } as Setup;
  const cellOf = (person: string): PersonCell => {
    const existing = cells.get(person);
    if (existing !== undefined) return existing;
    const storage = new FakeCelldStorage();
    storages.set(person, storage);
    const cell = new PersonCell(
      { storage },
      s.env,
      async (cellStorage, name, extras) => {
        const harness = await openCellHarness(cellStorage, {
          person: name,
          version: "v0.0.0-test",
          env: {},
          models: gateway.models,
          ...extras,
        });
        opened.push(harness);
        return harness;
      },
      { pollMs: 5 },
    );
    cells.set(person, cell);
    return cell;
  };
  (s as { env: WorkerEnv }).env = {
    SECBOT_OPERATOR_KEY: KEY,
    SNAPSHOTS: bucket,
    HOUSEHOLD_CELL: { idFromName: (name) => name, get: () => household },
    PERSON_CELL: { idFromName: (name) => name, get: (id) => cellOf(String(id)) },
    ...extra,
  };
  setups.push(s);
  return s;
}

const call = (s: Setup, method: string, path: string, key: string | null = KEY) =>
  route(
    new Request(`http://cell${path}`, {
      method,
      headers: key === null ? {} : { [OPERATOR_HEADER]: key },
    }),
    s.env,
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

async function leadEntries(s: Setup, person: string): Promise<number> {
  const cell = s.cells.get(person);
  if (cell === undefined) return 0;
  const response = await cell.fetch(
    new Request(`http://cell/v1/cells/${person}/status`, { headers: { [PERSON_HEADER]: person } }),
  );
  expect(response.status).toBe(200);
  const harness = s.opened.filter((opened) => opened.person === person).at(-1);
  if (harness === undefined) throw new Error("no harness");
  return (await harness.root.entries({}, 500, undefined, BACKGROUND_CONTEXT)).items.length;
}

describe("operator routes", () => {
  it("refuse a request without the operator key, or with a wrong one, and log the refusal", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    expect((await call(s, "GET", "/ops/digest", null)).status).toBe(401);
    expect((await call(s, "GET", "/ops/digest", "wrong")).status).toBe(401);
    expect((await call(s, "POST", "/internal/household/read", "wrong")).status).toBe(401);
    const unkeyed = setup({ SECBOT_OPERATOR_KEY: "" });
    expect((await call(unkeyed, "GET", "/ops/digest")).status).toBe(401);
    const refused = loggedEvents(log.mock.calls).filter((line) => line.event === "ops.refused");
    expect(refused).toHaveLength(4);
    expect(refused[0]).toEqual({
      event: "ops.refused",
      level: "warn",
      route: "/ops/digest",
      reason: "operator_key",
    });
    expect(JSON.stringify(refused)).not.toContain(KEY);
  });

  it("snapshot every cell, then restore the owner's conversation and the household list", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    const owner = s.env.PERSON_CELL.get("owner") as unknown as PersonCell;
    await owner.submitInput("owner", "plan dinner", "req-00000001");
    await until(async () => (await leadEntries(s, "owner")) >= 2);
    await s.household.apply({
      opId: "owner:1:a",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "milk",
    });
    const entriesBefore = await leadEntries(s, "owner");

    const taken = await body(await call(s, "POST", "/ops/snapshot?id=pre-v1.0.0-42"));
    const snapshots = taken.snapshots as { cell: string; digest: string; bytes: number }[];
    expect(snapshots.map((item) => item.cell)).toEqual(["owner", "second", "household"]);
    expect([...s.bucket.objects.keys()]).toEqual([
      "snapshots/pre-v1.0.0-42/owner.json",
      "snapshots/pre-v1.0.0-42/second.json",
      "snapshots/pre-v1.0.0-42/household.json",
    ]);
    const ownerDigest = snapshots[0]?.digest;

    // Later work the restore must undo.
    await owner.submitInput("owner", "and lunch", "req-00000002");
    await until(async () => (await leadEntries(s, "owner")) > entriesBefore);
    await s.household.apply({
      opId: "owner:2:b",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "bread",
    });
    const storage = s.storages.get("owner");
    await storage?.deleteAlarm();

    const restored = await body(await call(s, "POST", "/ops/restore?id=pre-v1.0.0-42&cell=owner"));
    expect(restored).toMatchObject({ cell: "owner", digest: ownerDigest });
    expect(await leadEntries(s, "owner")).toBe(entriesBefore);
    expect(await storage?.getAlarm()).not.toBeNull();

    const household = await body(
      await call(s, "POST", "/ops/restore?id=pre-v1.0.0-42&cell=household"),
    );
    expect(household.digest).toBe(snapshots[2]?.digest);
    expect((await s.household.read("list")).items.map((item) => item.text)).toEqual(["milk"]);

    const lines = loggedEvents(log.mock.calls);
    expect(lines.filter((line) => line.event === "ops.snapshot")).toHaveLength(3);
    expect(lines.find((line) => line.event === "cell.restored" && line.cell === "owner")).toEqual({
      event: "cell.restored",
      level: "info",
      cell: "owner",
      digest: ownerDigest,
      rows: expect.any(Number),
    });
    const cellLines = JSON.stringify(
      lines.filter((line) => String(line.event).startsWith("cell.")),
    );
    expect(cellLines).not.toContain("plan dinner");
    expect(cellLines).not.toContain("milk");
  });

  it("refuses a later contract step, a missing snapshot, the secrets cell, and a bad id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    await call(s, "POST", "/ops/snapshot?id=s1&cells=household");
    const stored = JSON.parse(
      s.bucket.objects.get("snapshots/s1/household.json") ?? "{}",
    ) as CellDump;
    s.bucket.objects.set(
      "snapshots/s2/household.json",
      JSON.stringify({ ...stored, contractStep: 99 }),
    );
    const later = await call(s, "POST", "/ops/restore?id=s2&cell=household");
    expect(later.status).toBe(409);
    expect((await body(later)).error).toBe(
      "refusing a snapshot past contract step 3 (snapshot s2 has step 99)",
    );
    const missing = await call(s, "POST", "/ops/restore?id=s9&cell=owner");
    expect(missing.status).toBe(404);
    expect((await body(missing)).error).toBe("snapshot s9 not found for cell owner");
    expect((await call(s, "POST", "/ops/restore?id=s1&cell=secrets")).status).toBe(403);
    // Naming the secrets cell in a snapshot is a bad request; a cell another fleet serves is 404.
    expect((await call(s, "POST", "/ops/snapshot?id=s3&cells=secrets")).status).toBe(400);
    expect((await call(s, "GET", "/ops/digest?cells=secrets")).status).toBe(400);
    expect((await call(s, "POST", "/ops/snapshot?id=bad%20id")).status).toBe(400);
  });

  it("keeps a snapshot write-once: a second snapshot with the same id is refused and changes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    const first = await call(s, "POST", "/ops/snapshot?id=pre-v1.0.0-42");
    expect(first.status).toBe(200);
    const before = new Map(s.bucket.objects);
    expect(before.size).toBe(3);

    // The cells change after the first snapshot (a deploy ran), then the workflow is rerun.
    await s.household.apply({
      opId: "owner:3:d",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "eggs",
    });
    const again = await call(s, "POST", "/ops/snapshot?id=pre-v1.0.0-42");
    expect(again.status).toBe(409);
    expect((await body(again)).error).toBe(
      "snapshot pre-v1.0.0-42 already exists for cell owner; refusing to overwrite it",
    );
    expect(new Map(s.bucket.objects)).toEqual(before);

    // A partial overlap is refused before any object is written.
    s.bucket.objects.delete("snapshots/pre-v1.0.0-42/household.json");
    const partial = await call(s, "POST", "/ops/snapshot?id=pre-v1.0.0-42");
    expect(partial.status).toBe(409);
    expect(s.bucket.objects.has("snapshots/pre-v1.0.0-42/household.json")).toBe(false);
  });

  it("wipes cells, reports digests and heartbeat state, and accepts person for the second person", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    await s.household.apply({
      opId: "owner:3:c",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "eggs",
    });
    const before = (await body(await call(s, "GET", "/ops/digest?cells=household")))
      .cells as Record<string, { rows: number }>;
    expect(before.household?.rows).toBeGreaterThan(0);
    expect(await body(await call(s, "POST", "/ops/wipe?cells=household"))).toEqual({
      wiped: ["household"],
    });
    const after = (await body(await call(s, "GET", "/ops/digest?cells=household"))).cells as Record<
      string,
      { rows: number }
    >;
    expect(after.household?.rows).toBe(0);
    const beats = (await body(await call(s, "GET", "/ops/heartbeats?cells=person,household")))
      .cells as Record<string, unknown>;
    expect(Object.keys(beats)).toEqual(["second", "household"]);
    expect(beats.second).toMatchObject({ lastOkAt: null, lastOutcome: null });
    expect((await call(s, "POST", "/ops/write")).status).toBe(404);
  });

  it("refuses another fleet's cell with the phrase on every route", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup({ SECBOT_FLEET_CELLS: "owner" });
    const digest = await call(s, "GET", "/ops/digest?cells=household");
    expect(digest.status).toBe(404);
    expect((await body(digest)).error).toBe("cell household is served by another fleet");
    const health = await body(
      await route(new Request("http://cell/health?cells=person,owner"), s.env),
    );
    expect((health.cells as Record<string, unknown>).second).toEqual({
      status: "down",
      reason: "cell second is served by another fleet",
    });
    const chat = await route(new Request("http://cell/v1/cells/second/missed"), s.env);
    expect(chat.status).toBe(404);
    expect((await body(chat)).error).toBe("cell second is served by another fleet");
    const internal = await call(s, "POST", "/internal/household/read");
    expect(internal.status).toBe(404);
    const alarms = await body(await route(new Request("http://cell/alarms"), s.env));
    expect(Object.keys(alarms.cells as object)).toEqual(["owner"]);
    // Only the owner fleet's cells are snapshotted.
    const taken = await body(await call(s, "POST", "/ops/snapshot?id=s3"));
    expect((taken.snapshots as { cell: string }[]).map((item) => item.cell)).toEqual(["owner"]);
  });
});
