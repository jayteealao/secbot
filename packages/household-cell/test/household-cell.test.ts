// The household cell over RPC-shaped calls: the owner cell's change is read by the second cell
// (the local half), a response lost after apply() ran is retried with the same operation id and
// applies once (fault injection), and the cell keeps its alarm at its heartbeat routine.
import type { HouseholdApplyResult, HouseholdChange, HouseholdClient } from "@secbot/cell-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { HouseholdCell } from "../src/household-cell.ts";

const cells: HouseholdCell[] = [];
afterEach(async () => {
  for (const cell of cells.splice(0)) await cell.close();
  vi.restoreAllMocks();
});

function setup(options: { fetch?: typeof fetch; env?: Record<string, string> } = {}) {
  const storage = new FakeCelldStorage();
  const household = new HouseholdCell({ storage }, options.env ?? {}, {
    version: "v0.0.0-test",
    pollMs: 5,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  cells.push(household);
  return { storage, household };
}

/** A person cell's client whose network loses the answer of the next `apply` after it ran. */
function flakyClient(target: HouseholdCell, fromCell: string) {
  let dropNext = false;
  const client: HouseholdClient & { dropNextAnswer(): void } = {
    dropNextAnswer: () => {
      dropNext = true;
    },
    read: (document) => target.read(document),
    apply: async (change): Promise<HouseholdApplyResult> => {
      const result = await target.apply({ ...change, fromCell });
      if (dropNext) {
        dropNext = false;
        throw new Error("connection reset after the method started");
      }
      return result;
    },
  };
  return client;
}

/** An application retry with the same operation id, as a person cell does after a lost answer. */
async function applyWithRetry(client: HouseholdClient, change: HouseholdChange) {
  try {
    return await client.apply(change);
  } catch {
    return client.apply(change);
  }
}

describe("HouseholdCell", () => {
  it("lets the second cell read an item the owner cell added", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { household } = setup();
    const owner = flakyClient(household, "owner");
    const second = flakyClient(household, "second");
    const added = await owner.apply({
      opId: "owner:7:call-1",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "olive oil",
    });
    expect(added).toMatchObject({ outcome: "applied", itemId: "owner:7:call-1" });
    expect((await second.read("list")).items.map((item) => item.text)).toEqual(["olive oil"]);
    const applied = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === "household.change.applied");
    expect(applied).toEqual([
      {
        event: "household.change.applied",
        document: "list",
        item_id: "owner:7:call-1",
        kind: "add",
        from_cell: "owner",
        outcome: "applied",
        seq: 1,
      },
    ]);
    expect(JSON.stringify(applied)).not.toContain("olive");
  });

  it("applies a change once when the answer was lost after apply() ran and the client retried", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { household } = setup();
    const owner = flakyClient(household, "owner");
    owner.dropNextAnswer();
    const change = {
      opId: "owner:9:call-2",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "rice",
    } as const;
    const result = await applyWithRetry(owner, change);
    expect(result).toMatchObject({ outcome: "applied", duplicate: true });
    expect((await household.read("list")).items).toHaveLength(1);
    expect(await household.history("list")).toHaveLength(1);
  });

  it("reports up, keeps its alarm at the heartbeat wake, and reports a missing alarm", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { household, storage } = setup();
    expect(await household.status()).toEqual({ status: "up", version: "v0.0.0-test", roles: [] });
    const report = await household.alarmReport();
    expect(report).toMatchObject({ cell: "household", ok: true, earliestSource: "heartbeat" });
    expect(report.alarm).toBe(report.earliest);
    await storage.deleteAlarm();
    expect(await household.alarmReport()).toMatchObject({ ok: false, problem: "no next alarm" });
    const late = Date.parse(report.earliest ?? "") + 60_000;
    await storage.setAlarm(late);
    expect(await household.alarmReport()).toMatchObject({ ok: false, problem: "alarm mismatch" });
    expect((await household.fetch(new Request("http://cell/status"))).status).toBe(200);
    expect((await household.fetch(new Request("http://cell/other"))).status).toBe(404);
  });

  it("pings its heartbeat when its alarm fires late, and re-arms to the next wake", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.now();
    const pings: string[] = [];
    const storage = new FakeCelldStorage();
    const make = () =>
      new HouseholdCell(
        { storage },
        { SECBOT_HEARTBEAT_URLS: "household:https://heartbeat.example.test/household" },
        {
          now: () => clock,
          pollMs: 5,
          fetch: async (input) => {
            pings.push(String(input));
            return new Response("ok");
          },
        },
      );
    const first = make();
    await first.status();
    const due = await storage.getAlarm();
    await first.close();
    if (due === null) throw new Error("no alarm after open");
    clock = due + 90_000;
    const second = make();
    cells.push(second);
    expect(storage.takeDueAlarm(clock)).toBe(due);
    await second.alarm({ retryCount: 0, isRetry: false, scheduledTime: due });
    expect(pings).toHaveLength(1);
    expect(await storage.getAlarm()).toBe(clock + 240_000);
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines.find((line) => line.event === "alarm.fired")).toMatchObject({
      cell: "household",
      late_ms: 90_000,
      retry_count: 0,
    });
  });
});
