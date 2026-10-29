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
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  type Responder,
  until,
} from "@secbot/cell-harness/testing";
import { jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import type { CellDump } from "@secbot/cell-storage";
import { HouseholdCell } from "@secbot/household-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_HEADER } from "../src/internal-rpc.ts";
import { CELL_STOP_TIMEOUT_MS, type OpsDeps, type SnapshotBucket, stopServed } from "../src/ops.ts";
import { PERSON_HEADER, PersonCell } from "../src/person-cell.ts";
import { route, type WorkerEnv } from "../src/routes.ts";

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

function setup(extra: Partial<WorkerEnv> = {}, respond?: Responder): Setup {
  const gateway = createFauxGateway(respond);
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

const call = (
  s: Setup,
  method: string,
  path: string,
  key: string | null = KEY,
  payload?: unknown,
) =>
  route(
    new Request(`http://cell${path}`, {
      method,
      headers: key === null ? {} : { [OPERATOR_HEADER]: key },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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

describe("the owner's stop and board across fleets", () => {
  const fleetB = () => setup({ SECBOT_FLEET_CELLS: "second,household" });
  /** Fleet A serves the owner and reaches fleet B at its address. */
  const fleetA = (b: Setup, answer?: () => Response) => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      answer !== undefined ? answer() : route(new Request(input, init), b.env),
    );
    return setup({
      SECBOT_FLEET_CELLS: "owner",
      SECBOT_HOUSEHOLD_URL: "http://fleet-b.internal:8080",
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops every cell of one fleet and answers each board", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    const stopped = await call(s, "POST", "/ops/stop");
    expect(stopped.status).toBe(200);
    expect(await body(stopped)).toEqual({
      cells: [
        { cell: "owner", jobs: 0, turn: false, shared: false },
        { cell: "second", jobs: 0, turn: false, shared: false },
        { cell: "household", jobs: 0, turn: false, shared: true },
      ],
      missing: [],
    });
    expect(loggedEvents(log.mock.calls).find((line) => line.event === "ops.stop")).toEqual({
      event: "ops.stop",
      level: "info",
      cells: ["owner", "second", "household"],
      missing: [],
    });
    const owner = await call(s, "GET", "/ops/jobs?cell=owner");
    expect(owner.status).toBe(200);
    expect(await body(owner)).toMatchObject({ person: "owner", operator: true, live: 0, rows: [] });
    expect(await body(await call(s, "GET", "/ops/jobs?cell=person"))).toMatchObject({
      person: "second",
      operator: true,
    });
    expect(await body(await call(s, "GET", "/ops/jobs?cell=household"))).toMatchObject({
      person: "household",
      operator: true,
      rows: [],
    });
    expect((await call(s, "GET", "/ops/jobs")).status).toBe(400);
    expect((await call(s, "GET", "/ops/jobs?cell=secrets")).status).toBe(404);
  });

  it("reaches the other fleet's cells through its internal routes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const b = fleetB();
    const a = fleetA(b);
    expect(await body(await call(a, "POST", "/ops/stop"))).toEqual({
      cells: [
        { cell: "owner", jobs: 0, turn: false, shared: false },
        { cell: "second", jobs: 0, turn: false, shared: false },
        { cell: "household", jobs: 0, turn: false, shared: true },
      ],
      missing: [],
    });
    const second = await call(a, "GET", "/ops/jobs?cell=second");
    expect(second.status).toBe(200);
    expect(await body(second)).toMatchObject({ person: "second", operator: true });
    expect(await body(await call(a, "GET", "/ops/jobs?cell=household"))).toMatchObject({
      person: "household",
    });
    // The other fleet serves only its own cells.
    const foreign = await route(
      new Request("http://cell/internal/jobs", {
        method: "POST",
        headers: { [OPERATOR_HEADER]: KEY },
        body: JSON.stringify({ cell: "owner" }),
      }),
      b.env,
    );
    expect(foreign.status).toBe(404);
  });

  it("names the cells of a fleet that does not answer, and still stops its own", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = fleetB();
    const a = fleetA(b, () => Response.json({ error: "unavailable" }, { status: 503 }));
    const stopped = await call(a, "POST", "/ops/stop");
    expect(stopped.status).toBe(200);
    expect(await body(stopped)).toEqual({
      cells: [{ cell: "owner", jobs: 0, turn: false, shared: false }],
      missing: ["second", "household"],
    });
    expect(
      loggedEvents(warn.mock.calls).find((line) => line.event === "ops.stop_unanswered"),
    ).toMatchObject({
      status: 503,
      attempts: 3,
    });
    expect((await call(a, "GET", "/ops/jobs?cell=second")).status).toBe(503);
    // With no address for the other fleet, its cells are missing too.
    const alone = setup({ SECBOT_FLEET_CELLS: "owner" });
    expect((await body(await call(alone, "POST", "/ops/stop"))).missing).toEqual([
      "second",
      "household",
    ]);
  });

  it("refuses all four routes without the operator key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    expect((await call(s, "POST", "/ops/stop", null)).status).toBe(401);
    expect((await call(s, "GET", "/ops/jobs?cell=owner", null)).status).toBe(401);
    expect((await call(s, "POST", "/internal/stop", null)).status).toBe(401);
    expect((await call(s, "POST", "/internal/jobs", "wrong")).status).toBe(401);
  });
});

describe("a person cell's measured number", () => {
  /** Research jobs that hold on the slow fixture tool (the test-cell switch is on). */
  const slowJobs: Responder = (request) => {
    if (request.role !== "research") return jobResponder(request);
    return request.last?.role === "toolResult"
      ? fauxAssistantMessage([fauxText("three options")])
      : fauxAssistantMessage([fauxToolCall("fixture_slow_lookup", { topic: "flights" })], {
          stopReason: "toolUse",
        });
  };
  const AT = Date.UTC(2026, 9, 29);

  it("sets and clears the number, and the owner's board shows the line once jobs pass it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup({ SECBOT_TEST_FIXTURES: "1" }, slowJobs);
    const set = await call(s, "PUT", "/ops/capacity?cell=owner", KEY, { measured: 1, at: AT });
    expect(set.status).toBe(200);
    expect(await body(set)).toEqual({ person: "owner", measured: 1, at: AT });
    expect(loggedEvents(log.mock.calls).find((line) => line.event === "ops.capacity_set")).toEqual({
      event: "ops.capacity_set",
      level: "info",
      cell: "owner",
      ok: true,
      measured: 1,
    });
    const harness = s.opened.find((opened) => opened.person === "owner");
    if (harness === undefined) throw new Error("no owner harness");
    const lines = [1, 2]
      .map((n) => startJobLine({ title: `job ${n}`, brief: `look ${n}`, template: "research" }))
      .join("\n");
    await (await harness.submit(lines, "start")).wait(BACKGROUND_CONTEXT);
    await until(
      async () =>
        Object.values((await harness.board()).jobs).filter((row) => row.status === "running")
          .length === 2,
    );
    const board = await body(await call(s, "GET", "/ops/jobs?cell=owner"));
    expect(board.capacity).toMatchObject({ jobsAtOnce: 2, measured: 1, at: AT });
    const cleared = await call(s, "PUT", "/ops/capacity?cell=owner", KEY, {
      measured: null,
      at: null,
    });
    expect(await body(cleared)).toEqual({ person: "owner", measured: null, at: null });
    expect((await body(await call(s, "GET", "/ops/jobs?cell=owner"))).capacity).toBeNull();
  });

  it("refuses a bad body, the household and secrets cells, and a call without the key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    for (const payload of [
      { measured: 0, at: AT },
      { measured: 1001, at: AT },
      { measured: 2.5, at: AT },
      { measured: "4", at: AT },
      { measured: 4, at: null },
      { measured: null, at: AT },
      { measured: 4, at: -1 },
      {},
    ]) {
      expect((await call(s, "PUT", "/ops/capacity?cell=owner", KEY, payload)).status).toBe(400);
    }
    const good = { measured: 4, at: AT };
    expect((await call(s, "PUT", "/ops/capacity?cell=household", KEY, good)).status).toBe(404);
    expect((await call(s, "PUT", "/ops/capacity?cell=secrets", KEY, good)).status).toBe(404);
    expect((await call(s, "PUT", "/ops/capacity", KEY, good)).status).toBe(400);
    expect((await call(s, "PUT", "/ops/capacity?cell=owner", null, good)).status).toBe(401);
    const alone = setup({ SECBOT_FLEET_CELLS: "owner" });
    expect((await call(alone, "PUT", "/ops/capacity?cell=second", KEY, good)).status).toBe(404);
  });
});

describe("the owner's stop of this fleet's cells", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops every cell at once and names a cell that does not answer in time", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked: string[] = [];
    const deps = {
      cells: ["owner", "second", "household"],
      stubOf: () => undefined,
      guardOf: (cell: string) => ({
        stopOf: async () => {
          asked.push(cell);
          // The owner's cell hangs; the second answers.
          if (cell === "owner") return new Promise<never>(() => {});
          return { ok: true as const, value: { jobs: 1, turn: false } };
        },
      }),
      householdJobs: () => ({
        stopJobs: async () => {
          asked.push("household");
          return { jobs: 2, turn: false };
        },
      }),
    } as unknown as OpsDeps;
    const pending = stopServed(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.sort()).toEqual(["household", "owner", "second"]);
    await vi.advanceTimersByTimeAsync(CELL_STOP_TIMEOUT_MS);
    expect(await pending).toEqual({
      cells: [
        { cell: "second", jobs: 1, turn: false, shared: false },
        { cell: "household", jobs: 2, turn: false, shared: true },
      ],
      missing: ["owner"],
    });
    expect(
      loggedEvents(warn.mock.calls).find((line) => line.event === "ops.stop_failed"),
    ).toMatchObject({ cell: "owner" });
  });
});
