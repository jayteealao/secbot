// Routines and the durable wake-time store. The next alarm is the
// earliest wake time stored in the live tasks' checkpoints. A routine that is overdue when
// the cell starts runs once, and its next wake counts from then. A routine whose database is gone
// backs off instead of running again at once.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  Harness,
  type HarnessInspection,
} from "@earendil-works/pi-durable";
import { needsReopen, openCelldStorageWithDatabase } from "@secbot/cell-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { alarmVerdict } from "../src/alarm.ts";
import { HEARTBEAT_EVERY_MS } from "../src/heartbeat.ts";
import { scheduleReminder } from "../src/reminder.ts";
import { defineRoutine, ensureRoutines, RoutinesDoc } from "../src/routines.ts";
import { LIVENESS_WAKE_MS, nextWake, wakesOf } from "../src/wake-times.ts";
import { loggedEvents, openTestCell, type TestCell, until } from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

type Task = HarnessInspection["tasks"][number];
const task = (
  id: number,
  kind: string,
  checkpoint: Record<string, unknown> | undefined,
  kindOfState: Task["state"]["kind"] = "running",
): Task =>
  ({
    record: {
      id,
      kind,
      state:
        checkpoint === undefined
          ? { status: "completing", outcome: { status: "completed", result: null } }
          : { status: "running", checkpoint },
    },
    state: { kind: kindOfState },
  }) as unknown as Task;

describe("wake times", () => {
  it("reads routine, model-retry, model-poll, and compaction-retry times from checkpoints only", () => {
    const summary = wakesOf({
      tasks: [
        task(1, "secbot.routine:heartbeat", { phase: "wait", wakeAt: 5_000 }),
        task(2, "secbot.routine:reminder", { phase: "wait", wakeAt: 3_000 }),
        task(3, "pi.generation", { phase: "retry", until: 4_000, attempt: 2 }),
        task(4, "pi.generation", { phase: "poll", pollAt: 6_000 }),
        task(5, "pi.compaction", { phase: "retry", until: 7_000 }),
        task(6, "pi.generation", { phase: "stream" }),
        task(7, "missing.kind", { phase: "x" }, "blocked"),
      ],
    });
    expect(summary.wakes.map((wake) => [wake.kind, wake.at])).toEqual([
      ["routine", 3_000],
      ["model-retry", 4_000],
      ["routine", 5_000],
      ["model-poll", 6_000],
      ["compaction-retry", 7_000],
    ]);
    expect(summary.liveUntimed).toBe(1);
    // The earliest timer wins over the liveness wake when it is sooner.
    expect(nextWake(summary, 0)).toEqual({ at: 3_000, source: "reminder" });
    // Untimed live work with every timer further away: wake in a minute to finish it.
    const far = {
      wakes: [{ taskId: "1", kind: "routine" as const, source: "heartbeat", at: 500_000 }],
      liveUntimed: 1,
    };
    expect(nextWake(far, 10_000)).toEqual({ at: 10_000 + LIVENESS_WAKE_MS, source: "liveness" });
    expect(nextWake({ wakes: [], liveUntimed: 2 }, 0)).toEqual({
      at: LIVENESS_WAKE_MS,
      source: "liveness",
    });
    expect(nextWake({ wakes: [], liveUntimed: 0 }, 0)).toBeUndefined();
  });

  it("judges a missing alarm and an alarm later than the earliest timer", () => {
    const summary = wakesOf({
      tasks: [task(1, "secbot.routine:heartbeat", { phase: "wait", wakeAt: 5_000 })],
    });
    expect(alarmVerdict("owner", 5_000, summary)).toMatchObject({ ok: true });
    expect(alarmVerdict("owner", 4_000, summary)).toMatchObject({ ok: true });
    expect(alarmVerdict("owner", 6_000, summary)).toMatchObject({
      ok: false,
      problem: "alarm mismatch",
    });
    expect(alarmVerdict("owner", null, summary)).toMatchObject({
      ok: false,
      problem: "no next alarm",
    });
    expect(alarmVerdict("owner", null, { wakes: [], liveUntimed: 0 })).toMatchObject({ ok: true });
  });

  it("puts the next alarm at the earliest stored wake: the heartbeat, then a sooner reminder", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = Date.now();
    test = await openTestCell({ now: () => now });
    const t = test;
    // The starter specialists' anchor tasks end right after the open; then only timers remain.
    await until(async () => (await t.cell.wakes()).summary.liveUntimed === 0);
    const first = await test.cell.wakes();
    expect(first.next).toEqual({ at: now + HEARTBEAT_EVERY_MS, source: "heartbeat" });
    const routines = await test.cell.harness.snapshot(RoutinesDoc, BACKGROUND_CONTEXT);
    expect(Object.keys(routines?.tasks ?? {})).toEqual(["heartbeat"]);

    await scheduleReminder(
      test.cell.harness,
      test.cell.reminders,
      "test:1",
      now + 60_000,
      "check the oven",
      BACKGROUND_CONTEXT,
    );
    const second = await test.cell.wakes();
    expect(second.next).toEqual({ at: now + 60_000, source: "reminder" });
    expect(second.summary.wakes.map((wake) => wake.source)).toEqual(["reminder", "heartbeat"]);
  });
});

describe("routines", () => {
  it("runs an overdue routine once after a late start and counts its next wake from then", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.now();
    const pings: string[] = [];
    test = await openTestCell({
      now: () => clock,
      env: { SECBOT_HEARTBEAT_URLS: "owner:https://heartbeat.example.test/owner-cell" },
      fetch: async (input) => {
        pings.push(String(input));
        return new Response("ok");
      },
    });
    const opened = test;
    await until(async () => (await opened.cell.wakes()).summary.liveUntimed === 0);
    const wakeAt = (await test.cell.wakes()).next?.at ?? 0;
    expect(wakeAt).toBe(clock + HEARTBEAT_EVERY_MS);

    // The cell is down past three heartbeat times, as during an upgrade.
    await test.cell.close();
    clock = wakeAt + 3 * HEARTBEAT_EVERY_MS + 1_000;
    const t = test;
    t.cell = await (async () => {
      const reopened = await openTestCell({
        storage: t.storage,
        gateway: t.gateway,
        now: () => clock,
        env: { SECBOT_HEARTBEAT_URLS: "owner:https://heartbeat.example.test/owner-cell" },
        fetch: async (input) => {
          pings.push(String(input));
          return new Response("ok");
        },
      });
      return reopened.cell;
    })();
    await until(() => loggedEvents(log.mock.calls).some((line) => line.event === "routine.fired"));
    await until(async () => (await t.cell.wakes()).next?.at === clock + HEARTBEAT_EVERY_MS);

    expect(pings).toHaveLength(1);
    const lines = loggedEvents(log.mock.calls);
    const fired = lines.filter((line) => line.event === "routine.fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      cell: "owner",
      routine: "heartbeat",
      outcome: "ok",
      wake_at: new Date(wakeAt).toISOString(),
      late_ms: clock - wakeAt,
    });
    expect(lines.find((line) => line.event === "harness.recovered")).toMatchObject({
      cell: "owner",
      overdue_routines: 1,
      pending_tasks: 0,
    });
    // The ping URL never reaches a log line.
    expect(JSON.stringify(lines)).not.toContain("heartbeat.example.test");
  });

  it("re-creates a recurring routine whose task ended, and writes a routine's record with its next wake", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const records: number[] = [];
    let changes = 0;
    const tick = defineRoutine(
      {
        name: "tick",
        every: 1_000,
        run: async (fire) => ({
          outcome: "ok",
          record: () => {
            records.push(fire.wakeAt);
          },
        }),
      },
      { cell: "owner", onWakeChange: () => changes++ },
    );
    expect(() =>
      defineRoutine({ name: "Bad Name", run: async () => ({ outcome: "ok" }) }, { cell: "x" }),
    ).toThrow();
    expect(() =>
      defineRoutine(
        { name: "fast", every: 10, run: async () => ({ outcome: "ok" }) },
        { cell: "x" },
      ),
    ).toThrow();
    test = await openTestCell({ routines: [{ routine: tick, firstWakeMs: 0 }] });
    const t = test;
    await until(() => records.length >= 1);
    expect(changes).toBeGreaterThanOrEqual(1);
    const doc = await t.cell.harness.snapshot(RoutinesDoc, BACKGROUND_CONTEXT);
    const tickTask = doc?.tasks.tick;
    if (tickTask === undefined) throw new Error("no tick task");
    await t.cell.harness.abortTask(tickTask, BACKGROUND_CONTEXT);
    await t.cell.harness.waitForTask(tickTask, BACKGROUND_CONTEXT);
    const created = await ensureRoutines(
      t.cell.harness,
      [{ routine: tick }],
      Date.now(),
      BACKGROUND_CONTEXT,
    );
    expect(created).toEqual(["tick"]);
    const again = await ensureRoutines(
      t.cell.harness,
      [{ routine: tick }],
      Date.now(),
      BACKGROUND_CONTEXT,
    );
    expect(again).toEqual([]);
  });
});

describe("a routine on a gone database", () => {
  it("reports once and backs off instead of running again at once; a close ends the back-off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = new FakeCelldStorage();
    const { storage } = await openCelldStorageWithDatabase(fake);
    let runs = 0;
    const reports: unknown[] = [];
    const tick = defineRoutine(
      {
        name: "tick",
        every: 60_000,
        spends: false,
        run: async () => {
          runs++;
          // celld gives the cell back while the routine runs: its next commit fails. A guard for
          // the failing case: without the back-off the routine runs again at once and starves the
          // timers, so the database comes back after 200 runs to end the loop.
          fake.gaveBack = runs >= 200 ? undefined : "TestCell:routine";
          return { outcome: "ok" };
        },
      },
      { cell: "test", goneBackoffMs: 10_000 },
    );
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-routines", tasks: [tick.task] }));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry, onReport: (error) => reports.push(error) },
      BACKGROUND_CONTEXT,
    );
    try {
      await harness.root(BACKGROUND_CONTEXT);
      await ensureRoutines(
        harness,
        [{ routine: tick, firstWakeMs: 0 }],
        Date.now(),
        BACKGROUND_CONTEXT,
      );
      harness.resume();
      await new Promise((resolve) => setTimeout(resolve, 500));
      // One run, one storage-gone report, then the back-off: no second run in 500 ms.
      expect(runs).toBe(1);
      expect(reports.filter((error) => needsReopen(error))).toHaveLength(1);
    } finally {
      // A close during the back-off ends it: the close does not wait out the 10 s.
      fake.gaveBack = undefined;
      const started = Date.now();
      await harness.close(BACKGROUND_CONTEXT);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    expect(runs).toBe(1);
  }, 30_000);
});
