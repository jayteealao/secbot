// The test-cell durability lab on the stand-in: arming puts a hand-off mid-call, a reminder, and an
// open marker transaction in flight; a new activation on the same storage (a restart) continues
// the job; the alarm can be set wrong or removed and is reported so; the household round trip
// goes from the owner cell to the second cell. The SIGKILL itself runs on the test cell
// (test:durability) and locally in cell-harness crash.test.ts.
import { FakeCelldStorage, until } from "@secbot/cell-harness/testing";
import { HouseholdCell } from "@secbot/household-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import conformanceWorker, { type ConformanceEnv } from "../src/conformance-entry.ts";
import { DurabilityLabCell, type LabEnv } from "../src/durability-lab.ts";
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
});
