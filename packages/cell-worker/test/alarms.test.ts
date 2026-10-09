// The person cell's alarm on the node:sqlite stand-in. The alarm equals the earliest stored
// wake time, a sooner reminder moves it, and the read-only route reports an induced later alarm
// and a missing one without re-arming. Locally: on an idle cell whose harness is not
// open, the alarm wakes it, the due reminder reaches the lead, and the lead's relay reaches an
// open session socket. Locally: the owner cell's household change is read by the
// second cell through the household cell. /alarms answers per cell; `person` is the second
// person's cell (the release workflows' name), and no cells means every cell of the fleet.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  CellAlarm,
  type CellHarness,
  openCellHarness,
  scheduleReminder,
} from "@secbot/cell-harness";
import {
  createFauxGateway,
  FakeCelldStorage,
  type FauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  until,
} from "@secbot/cell-harness/testing";
import { HouseholdCell } from "@secbot/household-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alarms, route, type WorkerEnv } from "../src/index.ts";
import { PERSON_HEADER, PersonCell, type SocketLike } from "../src/person-cell.ts";

class FakeSocket implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
}

const relay = (request: FauxRequest) =>
  request.lastText.startsWith("[reminder] ")
    ? fauxAssistantMessage([fauxText(`Reminder for you: ${request.lastText.slice(11)}`)])
    : fauxAssistantMessage([fauxText(`${request.role} says: ${request.lastText.slice(0, 40)}`)]);

interface Setup {
  readonly gateway: FauxGateway;
  readonly storages: Map<string, FakeCelldStorage>;
  readonly opened: CellHarness[];
  readonly household: HouseholdCell;
  readonly env: WorkerEnv;
  readonly sockets: FakeSocket[];
  /** A fresh activation of a person's cell on its storage (as after an eviction). */
  activate(person: string): PersonCell;
  cells: Map<string, PersonCell>;
}

const setups: Setup[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) {
    for (const cell of setup.opened) await cell.close().catch(() => {});
    await setup.household.close();
  }
  vi.restoreAllMocks();
});

function setup(): Setup {
  const gateway = createFauxGateway(relay);
  const storages = new Map<string, FakeCelldStorage>();
  const opened: CellHarness[] = [];
  const sockets: FakeSocket[] = [];
  const tags = new Map<SocketLike, string[]>();
  const household = new HouseholdCell({ storage: new FakeCelldStorage() }, {}, { pollMs: 5 });
  const s: Setup = {
    gateway,
    storages,
    opened,
    household,
    sockets,
    cells: new Map(),
    env: undefined as unknown as WorkerEnv,
    activate(person) {
      let storage = storages.get(person);
      if (storage === undefined) {
        storage = new FakeCelldStorage();
        storages.set(person, storage);
      }
      const cell = new PersonCell(
        {
          storage,
          getWebSockets: () => (person === "owner" ? sockets : []),
          getTags: (socket) => tags.get(socket) ?? [],
          acceptWebSocket: (socket, given) => tags.set(socket, given ?? []),
        },
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
      s.cells.set(person, cell);
      return cell;
    },
  };
  const householdNamespace = { idFromName: (name: string) => name, get: () => household };
  (s as { env: WorkerEnv }).env = {
    HOUSEHOLD_CELL: householdNamespace,
    PERSON_CELL: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: (request) => (s.cells.get(String(id)) ?? s.activate(String(id))).fetch(request),
      }),
    },
  };
  const socket = new FakeSocket();
  sockets.push(socket);
  tags.set(socket, ["laptop", "owner"]);
  setups.push(s);
  return s;
}

const status = (s: Setup, person: string) =>
  route(new Request(`http://cell/health?cells=${person}`), s.env);

const alarmRoute = async (s: Setup, person: string) => {
  const cell = s.cells.get(person) ?? s.activate(person);
  const response = await cell.fetch(
    new Request(`http://cell/v1/cells/${person}/alarm`, { headers: { [PERSON_HEADER]: person } }),
  );
  return (await response.json()) as Record<string, unknown>;
};

const idle = async (s: Setup, index = 0) => {
  await until(async () => {
    const cell = s.opened[index];
    return cell !== undefined && (await cell.wakes()).summary.liveUntimed === 0;
  });
};

describe("person cell alarm", () => {
  it("equals the earliest stored wake time, and a sooner reminder moves it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    await status(s, "owner");
    await idle(s);
    const storage = s.storages.get("owner");
    const harness = s.opened[0];
    if (storage === undefined || harness === undefined) throw new Error("setup failed");
    await until(
      async () => (await storage.getAlarm()) === (await harness.wakes()).summary.wakes[0]?.at,
    );
    expect((await harness.wakes()).summary.wakes[0]?.source).toBe("heartbeat");

    const soon = Date.now() + 120_000;
    await scheduleReminder(
      harness.harness,
      harness.reminders,
      "t:1",
      soon,
      "x",
      BACKGROUND_CONTEXT,
    );
    // What the set_reminder tool's wake-change callback does.
    await new CellAlarm(storage, "owner").rearm(harness);
    expect(await storage.getAlarm()).toBe(soon);
    expect(await alarmRoute(s, "owner")).toMatchObject({ ok: true, earliestSource: "reminder" });
  });

  it("reports an induced later alarm and a missing alarm without re-arming", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    await status(s, "owner");
    await idle(s);
    const storage = s.storages.get("owner");
    if (storage === undefined) throw new Error("setup failed");
    const report = await alarmRoute(s, "owner");
    const earliest = Date.parse(String(report.earliest));
    await storage.setAlarm(earliest + 3_600_000);
    expect(await alarmRoute(s, "owner")).toMatchObject({ ok: false, problem: "alarm mismatch" });
    expect(await storage.getAlarm()).toBe(earliest + 3_600_000);
    await storage.deleteAlarm();
    expect(await alarmRoute(s, "owner")).toMatchObject({ ok: false, problem: "no next alarm" });
    expect(await storage.getAlarm()).toBeNull();
    // A fresh activation (an evicted cell) reports what was stored, then its open re-arms, so
    // the next check passes.
    s.activate("owner");
    expect(await alarmRoute(s, "owner")).toMatchObject({ ok: false, problem: "no next alarm" });
    await until(async () => (await alarmRoute(s, "owner")).ok === true);
  });

  it("wakes an idle cell for a due reminder, and the lead's relay reaches the open session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    await status(s, "owner");
    await idle(s);
    const first = s.opened[0];
    const storage = s.storages.get("owner");
    if (first === undefined || storage === undefined) throw new Error("setup failed");
    const due = Date.now() + 400;
    await scheduleReminder(
      first.harness,
      first.reminders,
      "t:2",
      due,
      "check the oven",
      BACKGROUND_CONTEXT,
    );
    await new CellAlarm(storage, "owner").rearm(first);
    expect(await storage.getAlarm()).toBe(due);
    // The cell goes idle and is evicted: its harness closes, and a new activation knows nothing.
    await first.close();
    s.opened.splice(0);
    const fresh = s.activate("owner");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const fired = storage.takeDueAlarm(Date.now());
    expect(fired).toBe(due);
    await fresh.alarm({ retryCount: 0, isRetry: false, scheduledTime: due });
    const socket = s.sockets[0];
    await until(() =>
      (socket?.sent ?? []).some(
        (frame) => frame.type === "answer" && frame.text === "Reminder for you: check the oven",
      ),
    );
    const leadReminders = s.gateway.requests.filter((request) =>
      request.lastText.startsWith("[reminder] "),
    );
    expect(leadReminders).toHaveLength(1);
    // After the due work, the alarm is back at the earliest stored timer.
    const reopened = s.opened[0];
    if (reopened === undefined) throw new Error("no reopened harness");
    await until(
      async () => (await storage.getAlarm()) === (await reopened.wakes()).summary.wakes[0]?.at,
    );
  });

  it("lets the second cell read the owner cell's household change", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    const owner = s.activate("owner");
    const second = s.activate("second");
    const change = {
      opId: "owner:lab:1",
      document: "list",
      fromCell: "owner",
      kind: "add" as const,
      text: "flour",
    };
    expect(await owner.householdChange("owner", change)).toMatchObject({ outcome: "applied" });
    expect(await owner.householdChange("owner", change)).toMatchObject({ duplicate: true });
    const read = await second.householdRead("list");
    expect(read.items.map((item) => [item.itemId, item.text])).toEqual([["owner:lab:1", "flour"]]);
  });

  it("answers /alarms for each named cell, with person naming the second person's cell", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = setup();
    const body = (await (
      await alarms(new URL("http://cell/alarms?cells=person,household,ghost"), s.env)
    ).json()) as { cells: Record<string, { ok: boolean; cell: string; reason?: string }> };
    expect(Object.keys(body.cells)).toEqual(["second", "household", "ghost"]);
    const every = (await (await alarms(new URL("http://cell/alarms"), s.env)).json()) as {
      cells: Record<string, unknown>;
    };
    expect(Object.keys(every.cells)).toEqual(["owner", "second", "household", "secrets"]);
    // This fleet has no secrets binding, so the secrets cell's alarm reads as not reachable.
    expect(every.cells.secrets).toMatchObject({ ok: false, reason: "no secrets binding" });
    expect(body.cells.ghost).toMatchObject({ ok: false, reason: "unknown cell" });
    expect(body.cells.household).toMatchObject({ cell: "household" });
    const health = (await (await status(s, "household")).json()) as {
      cells: Record<string, unknown>;
    };
    expect(health.cells.household).toMatchObject({ status: "up", roles: [] });
    const routed = await route(new Request("http://cell/alarms?cells=owner"), s.env);
    expect(routed.status).toBe(200);
  });
});
