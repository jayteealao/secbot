// The test-cell durability lab on the stand-in: arming puts a hand-off mid-call, a reminder, and an
// open marker transaction in flight; a new activation on the same storage (a restart) continues
// the job; the alarm can be set wrong or removed and is reported so; the household round trip
// goes from the owner cell to the second cell. The SIGKILL itself runs on the test cell
// (test:durability) and locally in cell-harness crash.test.ts. The heap load briefs all four
// specialists at once with one long job, and the write probe commits one row per call.
import { CellHarness, onLogEvent } from "@secbot/cell-harness";
import { FakeCelldStorage, until } from "@secbot/cell-harness/testing";
import { HouseholdCell } from "@secbot/household-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import conformanceWorker, { type ConformanceEnv } from "../src/conformance-entry.ts";
import { DurabilityLabCell, type LabEnv } from "../src/durability-lab.ts";
import { HarnessSlot } from "../src/harness-slot.ts";

import { OPERATOR_HEADER } from "../src/household-client.ts";
import { PersonCell } from "../src/person-cell.ts";

const labs: DurabilityLabCell[] = [];
const households: HouseholdCell[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
  for (const household of households.splice(0)) await household.close();
  vi.restoreAllMocks();
});

function env(): LabEnv {
  const household = new HouseholdCell({ storage: new FakeCelldStorage() }, {}, { pollMs: 5 });
  households.push(household);
  const householdNamespace = { idFromName: (name: string) => name, get: () => household };
  const persons = new Map<string, PersonCell>();
  return {
    HOUSEHOLD_CELL: householdNamespace,
    PERSON_CELL: {
      idFromName: (name) => name,
      get: (id) => {
        let cell = persons.get(String(id));
        if (cell === undefined) {
          cell = new PersonCell(
            { storage: new FakeCelldStorage() },
            { HOUSEHOLD_CELL: householdNamespace },
          );
          persons.set(String(id), cell);
        }
        return cell;
      },
    },
  };
}

const lab = (storage: FakeCelldStorage, labEnv: LabEnv = {}) => {
  const cell = new DurabilityLabCell({ storage }, labEnv, {
    hangMs: 60_000,
    holdMs: 200,
    pollMs: 5,
  });
  labs.push(cell);
  return cell;
};

const call = async (cell: DurabilityLabCell, method: string, path: string) =>
  (await (await cell.fetch(new Request(`http://cell${path}`, { method }))).json()) as Record<
    string,
    unknown
  >;

describe("DurabilityLabCell", () => {
  it("arms the three in-flight states, and a restart continues the cut-off job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const first = lab(storage);
    const armed = await call(first, "POST", "/lab/arm");
    expect(armed).toMatchObject({ armed: true, specialistCallStarted: true, holdMs: 200 });
    await until(async () => (await call(first, "GET", "/lab/state")).markerRows === 1);
    const before = await call(first, "GET", "/lab/state");
    expect(before).toMatchObject({ armed: true, followupReported: false });
    const tasks = before.tasks as { kind: string; wakeAt?: number }[];
    expect(tasks.find((task) => task.kind === "secbot.routine:reminder")?.wakeAt).toBe(
      armed.reminderAt,
    );
    expect(tasks.some((task) => task.kind === "secbot.routine:lab-tick")).toBe(true);

    // A restart: the old activation ends with its call still cut off; a new one continues it.
    await first.close();
    const second = lab(storage);
    await until(
      async () => (await call(second, "GET", "/lab/state")).followupReported === true,
      20_000,
    );
    const after = await call(second, "GET", "/lab/state");
    expect(after.calls).toMatchObject({ specialist: 1 });
    expect(after.armed).toBe(true);
    await until(async () => (await call(second, "GET", "/lab/alarm-report")).ok === true);
  }, 60_000);

  it("reports an induced later alarm and a missing one, and re-arms on request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cell = lab(new FakeCelldStorage());
    await until(async () => (await call(cell, "GET", "/lab/state")).liveUntimed === 0);
    const report = await call(cell, "GET", "/lab/alarm-report");
    const earliest = Date.parse(String(report.earliest));
    await call(cell, "POST", `/lab/alarm?set=${earliest + 3_600_000}`);
    expect(await call(cell, "GET", "/lab/alarm-report")).toMatchObject({
      ok: false,
      problem: "alarm mismatch",
    });
    await call(cell, "POST", "/lab/alarm?set=none");
    expect(await call(cell, "GET", "/lab/alarm-report")).toMatchObject({
      ok: false,
      problem: "no next alarm",
    });
    expect(
      (await cell.fetch(new Request("http://cell/lab/alarm?set=soon", { method: "POST" }))).status,
    ).toBe(400);
    expect(await call(cell, "POST", "/lab/rearm")).toMatchObject({ alarm: earliest });
    expect((await cell.fetch(new Request("http://cell/lab/nothing"))).status).toBe(404);
  });

  it("adds an item from the owner cell that the second cell reads, once per operation id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cell = lab(new FakeCelldStorage(), env());
    const result = await call(cell, "POST", "/lab/household-roundtrip");
    expect(result).toMatchObject({ ok: true, seenBySecond: true, copies: 1 });
    expect(
      await call(lab(new FakeCelldStorage()), "POST", "/lab/household-roundtrip"),
    ).toMatchObject({ ok: false });
  });

  it("closes its harness once when celld closes its database under running work, and opens a new one on the next request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const cell = lab(storage);
    await call(cell, "POST", "/lab/arm");
    const events: string[] = [];
    const count = (name: string) => events.filter((event) => event === name).length;
    // A guard for the failing case: without the fix the harness retries without end and starves
    // the timers, so the test gives the database back after 200 reports to end the loop.
    const stop = onLogEvent((event) => {
      events.push(event);
      if (count("harness.report") === 200) storage.gaveBack = undefined;
    });
    try {
      // celld gives the cell back (an idle eviction or a stop) while the hand-off still runs: the
      // database closes, and the cut-off call then answers into it.
      storage.gaveBack = "DurabilityLabCell:lab-test";
      cell.releaseHangs();
      await new Promise((resolve) => setTimeout(resolve, 500));
      // One line for the loss, then silence: no harness keeps working on the closed database.
      expect(count("cell.reopen")).toBe(1);
      expect(count("harness.report")).toBeLessThan(5);
      const reports = count("harness.report");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(count("harness.report")).toBe(reports);
      // celld takes the cell in again: the next request opens a new harness, which resumes the job.
      storage.gaveBack = undefined;
      await until(
        async () => (await call(cell, "GET", "/lab/state")).followupReported === true,
        20_000,
      );
      expect(count("cell.reopen")).toBe(1);
    } finally {
      stop();
    }
  }, 60_000);

  it("logs one report line per loss when celld closes its database and the old harness never finishes closing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const cell = new DurabilityLabCell(
      { storage },
      {},
      {
        hangMs: 60_000,
        holdMs: 200,
        pollMs: 5,
        reportSummaryMs: 200,
      },
    );
    labs.push(cell);
    await call(cell, "POST", "/lab/arm");
    const events: string[] = [];
    const count = (name: string) => events.filter((event) => event === name).length;
    const stop = onLogEvent((event) => {
      events.push(event);
    });
    // Every report still reaches the slot. A guard for the failing case: without the fix every
    // report is a log line and the retries starve the timers, so the test gives the database back
    // after 200 reports to end the loop.
    let reports = 0;
    const realLost = HarnessSlot.prototype.lost;
    const lost = vi.spyOn(HarnessSlot.prototype, "lost").mockImplementation(function (
      this: HarnessSlot,
      error: unknown,
      generation?: number,
    ) {
      reports++;
      if (reports === 200) storage.gaveBack = undefined;
      return realLost.call(this, error, generation);
    });
    // A close that never finishes, as when the old harness's own retries hold it: the old harness
    // keeps running on the closed database.
    const hung: CellHarness[] = [];
    const finishes: (() => void)[] = [];
    const realClose = CellHarness.prototype.close;
    const close = vi.spyOn(CellHarness.prototype, "close").mockImplementation(function (
      this: CellHarness,
    ) {
      hung.push(this);
      return new Promise<void>((resolve) => finishes.push(resolve));
    });
    try {
      storage.gaveBack = "DurabilityLabCell:lab-test";
      cell.releaseHangs();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(reports).toBeGreaterThan(1);
      expect(count("cell.reopen")).toBe(1);
      expect(count("harness.report")).toBe(1);
      expect(count("harness.reports_suppressed")).toBeGreaterThanOrEqual(1);
      // celld takes the cell in again and the old close ends: the next request opens a new harness,
      // which resumes the job, with no second reopen line.
      close.mockRestore();
      storage.gaveBack = undefined;
      for (const harness of hung) await realClose.call(harness).catch(() => {});
      for (const finish of finishes) finish();
      await until(
        async () => (await call(cell, "GET", "/lab/state")).followupReported === true,
        20_000,
      );
      expect(count("cell.reopen")).toBe(1);
    } finally {
      stop();
      close.mockRestore();
      lost.mockRestore();
    }
  }, 60_000);

  it("routes /lab/ in the test-cell worker", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cell = lab(new FakeCelldStorage());
    const workerEnv = {
      CONFORMANCE: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response("x") }),
      },
      LAB: { idFromName: (name: string) => name, get: () => cell },
    } as ConformanceEnv;
    const response = await conformanceWorker.fetch(
      new Request("http://cell/lab/alarm-report"),
      workerEnv,
    );
    expect(response.status).toBe(200);
    const missing = await conformanceWorker.fetch(new Request("http://cell/lab/state"), {
      CONFORMANCE: workerEnv.CONFORMANCE,
    });
    expect(missing.status).toBe(503);
  });

  it("loads the lead and all four specialists at once, with one long job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const cell = new DurabilityLabCell(
      { storage },
      {},
      { loadMs: 400, longJobMs: 1_500, pollMs: 5 },
    );
    labs.push(cell);
    expect(await call(cell, "POST", "/lab/load")).toMatchObject({ started: true });
    await until(async () => (await call(cell, "GET", "/lab/load")).specialistCalls === 4);
    const during = await call(cell, "GET", "/lab/load");
    expect(during.loading).toBe(true);
    expect(Number(during.live)).toBeGreaterThanOrEqual(4);
    await until(async () => (await call(cell, "GET", "/lab/load")).loading === false, 5_000);
  });

  it("commits one row per write probe through the test-cell worker's /ops/write", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const cell = lab(storage);
    const workerEnv = {
      CONFORMANCE: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response("x") }),
      },
      LAB: { idFromName: (name: string) => name, get: () => cell },
      SECBOT_OPERATOR_KEY: "k".repeat(32),
    } as ConformanceEnv;
    for (let index = 0; index < 3; index++) {
      const response = await conformanceWorker.fetch(
        new Request("http://cell/ops/write", {
          method: "POST",
          headers: { [OPERATOR_HEADER]: "k".repeat(32) },
        }),
        workerEnv,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ms: expect.any(Number) });
    }
    const rows = storage.database.prepare("SELECT count(*) AS n FROM ops_write_probe").get() as {
      n: number;
    };
    expect(Number(rows.n)).toBe(3);
  });
});
