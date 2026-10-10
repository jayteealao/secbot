// Spend and limits through the worker on the stand-in: the person's month behind the device key,
// the owner's views and changes behind the operator key (a person's limit, the developer budget,
// and the household time zone on the household cell's board), the refusals, and the session's
// order: connected, the usage line, held calls, unseen limit notices, then missed messages.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CellHarness, openCellHarness } from "@secbot/cell-harness";
import {
  addSpend,
  createFauxGateway,
  FakeCelldStorage,
  loggedEvents,
  passingDecision,
  until,
} from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index.ts";
import { PersonCell, type SocketLike } from "../src/person-cell.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, OPERATOR_KEY } from "./guard-setup.ts";

const setups: GuardSetup[] = [];
const harnesses: CellHarness[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) await closeAll(setup);
  for (const harness of harnesses.splice(0)) await harness.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(household = false, fleet?: string) {
  const s = await guardSetup(fleet, { household });
  setups.push(s);
  return s;
}

const device = (s: GuardSetup, method: string, path: string, body?: unknown) =>
  route(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    s.env,
  );

const operator = (
  s: GuardSetup,
  method: string,
  path: string,
  body?: unknown,
  key = OPERATOR_KEY,
) =>
  route(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { "x-secbot-operator": key, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    s.env,
  );

describe("the person's month (device key)", () => {
  it("answers the cost view with the release limit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const response = await device(s, "GET", "/v1/cells/owner/cost");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      person: "owner",
      spentUsd: 0,
      limitUsd: 25,
      percent: 0,
      line: "normal",
      mode: "shadow",
      byLayer: { agent: 0, decision: 0, reviewer: 0 },
      waiting: [],
      developer: { limitUsd: 50 },
    });
  });

  it("has no device-key route that changes a limit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    for (const method of ["PUT", "POST"]) {
      const response = await device(s, method, "/v1/cells/owner/limits", { limitUsd: 1000 });
      expect(response.status).toBe(404);
    }
    expect(
      ((await (await device(s, "GET", "/v1/cells/owner/cost")).json()) as { limitUsd: number })
        .limitUsd,
    ).toBe(25);
  });
});

describe("the owner's limits (operator key)", () => {
  it("refuses no key, a wrong key, and a device key, and logs ops.refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    expect(
      (await operator(s, "PUT", "/ops/limits?cell=owner", { limitUsd: 40 }, "wrong")).status,
    ).toBe(401);
    expect((await device(s, "PUT", "/ops/limits?cell=owner", { limitUsd: 40 })).status).toBe(401);
    expect((await device(s, "GET", "/ops/cost")).status).toBe(401);
    expect(
      loggedEvents(warn.mock.calls).filter((event) => event.event === "ops.refused"),
    ).toHaveLength(3);
    expect(
      ((await (await device(s, "GET", "/v1/cells/owner/cost")).json()) as { limitUsd: number })
        .limitUsd,
    ).toBe(25);
  });

  it("sets a person's limit for the next check and refuses a bad amount", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const set = await operator(s, "PUT", "/ops/limits?cell=owner", { limitUsd: 40 });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ person: "owner", limitUsd: 40, previousUsd: 25 });
    const cost = (await (await operator(s, "GET", "/ops/cost?cell=owner")).json()) as {
      limitUsd: number;
      asOf: number;
    };
    expect(cost.limitUsd).toBe(40);
    expect(typeof cost.asOf).toBe("number");
    for (const bad of [0, -5, 10_001, 1.234, "lots", null]) {
      const refused = await operator(s, "PUT", "/ops/limits?cell=owner", { limitUsd: bad });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/^refused: a limit is/);
    }
    expect((await operator(s, "PUT", "/ops/limits?cell=nobody", { limitUsd: 5 })).status).toBe(404);
  });

  it("keeps the developer budget and the time zone on the household board", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup(true);
    await device(s, "GET", "/v1/cells/owner/status");
    const developer = await operator(s, "PUT", "/ops/limits?budget=developer", { limitUsd: 60 });
    expect(developer.status).toBe(200);
    expect(await developer.json()).toEqual({ timeZone: null, developerLimitUsd: 60 });
    const zone = await operator(s, "PUT", "/ops/time-zone", { timeZone: "Europe/London" });
    expect(await zone.json()).toEqual({ timeZone: "Europe/London", developerLimitUsd: 60 });
    expect((await operator(s, "PUT", "/ops/time-zone", { timeZone: "Mars/Olympus" })).status).toBe(
      400,
    );
    expect((await operator(s, "PUT", "/ops/limits?budget=developer", { limitUsd: 0 })).status).toBe(
      400,
    );
    // The served cell read the new budget at once.
    const state = await s.harness("owner").budgetState();
    expect(state.developer.limitUsd).toBe(60);
    const household = (await (await operator(s, "GET", "/ops/cost")).json()) as {
      persons: { person: string; limitUsd: number }[];
      developer: { limitUsd: number };
      totalUsd: number;
    };
    expect(household.persons.map((row) => [row.person, row.limitUsd])).toEqual([
      ["owner", 25],
      ["second", 25],
    ]);
    expect(household.developer.limitUsd).toBe(60);
    expect(household.totalUsd).toBe(0);
  });

  it("answers the household view from the board for a cell another fleet serves", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup(true, "owner,household");
    await s.household?.reportSpend({
      opId: "second-1",
      cell: "second",
      month: new Date().toISOString().slice(0, 7),
      timeZone: "UTC",
      at: 1_000,
      spentUsd: 11.52,
      limitUsd: 25,
      mode: "shadow",
      modeSince: null,
      byLayer: { agent: 10.84, decision: 0.41, reviewer: 0.27 },
      byRole: { lead: 7.9 },
      developerUsd: 3.1,
      developerLimitUsd: 50,
      developerLines: [],
    });
    await device(s, "GET", "/v1/cells/owner/status");
    const second = (await (await operator(s, "GET", "/ops/cost?cell=second")).json()) as {
      spentUsd: number;
      asOf: number;
      byLayer: { agent: number };
    };
    expect(second).toMatchObject({ spentUsd: 11.52, asOf: 1_000, byLayer: { agent: 10.84 } });
    const household = (await (await operator(s, "GET", "/ops/cost")).json()) as {
      persons: { person: string; asOf: number }[];
    };
    expect(household.persons.map((row) => row.person)).toEqual(["owner", "second"]);
    expect(household.persons[1]?.asOf).toBe(1_000);
  });
});

class FakeSocket implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
}

describe("the session order", () => {
  it("sends connected, the usage line, held calls, unseen notices, then missed messages", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = createFauxGateway();
    const storage = new FakeCelldStorage();
    const sockets: FakeSocket[] = [];
    const tags = new Map<SocketLike, string[]>();
    let opened: CellHarness | undefined;
    const cell = new PersonCell(
      {
        storage,
        getWebSockets: () => sockets,
        getTags: (socket) => tags.get(socket) ?? [],
        acceptWebSocket: (socket, given) => tags.set(socket, given ?? []),
      },
      {},
      async (store, name) => {
        opened = await openCellHarness(store, {
          person: name,
          version: "v0.0.0-test",
          env: {},
          models: gateway.models,
          guard: { decision: passingDecision },
        });
        harnesses.push(opened);
        return opened;
      },
    );
    const request = (path: string) =>
      cell.fetch(
        new Request(`http://cell/v1/cells/owner${path}`, {
          headers: { "x-secbot-person": "owner", "x-secbot-device": "laptop" },
        }),
      );
    await request("/status");
    const harness = opened;
    if (harness === undefined) throw new Error("not opened");
    await harness.submit("hello", "order-00000001");
    await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
    await harness.setLimit(1, "owner");
    await addSpend(harness, 0.9);
    harness.budget.watch.trigger();
    await harness.budget.watch.settled();
    const server = new FakeSocket();
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = new FakeSocket();
        1 = server;
        constructor() {
          sockets.push(server);
        }
      },
    );
    // Node refuses a 101 Response, so the opening settles as a rejection after the work is done.
    await request("/session").catch(() => undefined);
    await until(() => server.sent.some((frame) => frame.type === "missed"));
    expect(server.sent.map((frame) => frame.type).slice(0, 4)).toEqual([
      "connected",
      "usage",
      "notice",
      "missed",
    ]);
    expect(server.sent[1]).toMatchObject({
      usage: { spentUsd: 0.9, limitUsd: 1, percent: 90, line: "warn", mode: "shadow" },
    });
    expect(server.sent[2]).toMatchObject({ notice: { budget: "person", line: 80 }, waiting: [] });
    // Shown once on this device: /missed no longer lists it.
    const missed = (await (await request("/missed")).json()) as { notices: unknown[] };
    expect(missed.notices).toEqual([]);
  });
});
