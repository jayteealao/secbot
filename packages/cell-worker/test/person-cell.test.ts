// The person cell's routes over the node:sqlite stand-in and a scripted model: status up with
// the version and five roles, the model and specialist routes, chat
// input and frames over a socket, and missed messages.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CellHarness, openCellHarness } from "@secbot/cell-harness";
import {
  ALTERNATE_MODEL,
  createFauxGateway,
  FakeCelldStorage,
  type FauxGateway,
  until,
} from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/device-auth.ts";
import { route, type WorkerEnv } from "../src/index.ts";
import { PersonCell, type SocketLike } from "../src/person-cell.ts";

const KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef";
const HOST = "cells.example.test";

class FakeSocket implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
}

interface Setup {
  readonly env: WorkerEnv;
  readonly cells: Map<string, PersonCell>;
  readonly sockets: FakeSocket[];
  readonly opened: CellHarness[];
  readonly gateway: FauxGateway;
}

const setups: Setup[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) for (const cell of setup.opened) await cell.close();
  vi.restoreAllMocks();
});

async function setup(): Promise<Setup> {
  const gateway = createFauxGateway();
  const sockets: FakeSocket[] = [];
  const opened: CellHarness[] = [];
  const cells = new Map<string, PersonCell>();
  const tags = new Map<SocketLike, string[]>();
  const cellFor = (person: string) => {
    let cell = cells.get(person);
    if (cell === undefined) {
      const state = {
        storage: new FakeCelldStorage(),
        getWebSockets: () => sockets,
        getTags: (socket: SocketLike) => tags.get(socket) ?? [],
        acceptWebSocket: (socket: SocketLike, given?: string[]) => tags.set(socket, given ?? []),
      };
      cell = new PersonCell(state, {}, async (storage, name) => {
        const harness = await openCellHarness(storage, {
          person: name,
          version: "v0.0.0-test",
          env: {},
          models: gateway.models,
        });
        opened.push(harness);
        return harness;
      });
      cells.set(person, cell);
    }
    return cell;
  };
  const env: WorkerEnv = {
    SECBOT_DEVICE_KEYS: `laptop:owner:${await sha256Hex(KEY)}`,
    SECBOT_PRIVATE_HOSTS: HOST,
    PERSON_CELL: {
      idFromName: (name) => name,
      get: (id) => ({ fetch: (request) => cellFor(String(id)).fetch(request) }),
    },
  };
  const result = { env, cells, sockets, opened, gateway };
  setups.push(result);
  // A socket that the session route would have accepted for the laptop.
  const socket = new FakeSocket();
  sockets.push(socket);
  tags.set(socket, ["laptop", "owner"]);
  return result;
}

const call = (s: Setup, method: string, path: string, body?: unknown) =>
  route(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    s.env,
  );

describe("PersonCell", () => {
  it("reports up with the version and the five roles, alone and through /health", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const status = await call(s, "GET", "/v1/cells/owner/status");
    expect(await status.json()).toEqual({
      status: "up",
      person: "owner",
      version: "v0.0.0-test",
      roles: ["lead", "household", "developer", "research", "health"],
    });
    const health = await route(
      new Request(`http://${HOST}/health?cells=owner,second,ghost`),
      s.env,
    );
    expect(await health.json()).toMatchObject({
      cells: {
        owner: { status: "up", version: "v0.0.0-test" },
        second: { status: "up", version: "v0.0.0-test" },
        ghost: { status: "down", reason: "unknown cell" },
      },
    });
  });

  it("changes a model, refuses an unknown one, and adds a specialist", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const refused = await call(s, "PUT", "/v1/cells/owner/models/lead", { model: "openai/nope" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("unknown model");
    const changed = await call(s, "PUT", "/v1/cells/owner/models/lead", { model: ALTERNATE_MODEL });
    expect(await changed.json()).toEqual({
      role: "lead",
      model: ALTERNATE_MODEL,
      source: "changed",
    });
    const added = await call(s, "POST", "/v1/cells/owner/specialists", {
      name: "garden",
      instruction: "You look after the plants.",
    });
    expect(added.status).toBe(201);
    const duplicate = await call(s, "POST", "/v1/cells/owner/specialists", {
      name: "garden",
      instruction: "Again.",
    });
    expect(duplicate.status).toBe(400);
    const models = (await (await call(s, "GET", "/v1/cells/owner/models")).json()) as {
      roles: { role: string }[];
    };
    expect(models.roles.map((entry) => entry.role)).toContain("garden");
    expect((await call(s, "PUT", "/v1/cells/owner/models/lead", {})).status).toBe(400);
    expect((await call(s, "GET", "/v1/cells/owner/nothing")).status).toBe(404);
  });

  it("submits a chat line unchanged, streams frames to the socket, and marks them delivered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    await call(s, "GET", "/v1/cells/owner/status");
    const cell = s.cells.get("owner");
    const socket = s.sockets[0];
    if (cell === undefined || socket === undefined) throw new Error("setup failed");
    await cell.webSocketMessage(
      socket,
      JSON.stringify({ type: "input", text: "hello lead", requestId: "req-00000001" }),
    );
    expect(socket.sent).toContainEqual({ type: "accepted", requestId: "req-00000001" });
    await until(() => socket.sent.some((frame) => frame.type === "answer"));
    expect(socket.sent.find((frame) => frame.type === "answer")).toMatchObject({
      text: "lead says: hello lead",
    });
    expect(s.gateway.requests.at(-1)?.lastText).toBe("hello lead");
    // The same request id again (a reconnect) submits nothing new.
    await cell.webSocketMessage(
      socket,
      JSON.stringify({ type: "input", text: "hello lead", requestId: "req-00000001" }),
    );
    await s.opened[0]?.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(s.gateway.requests.filter((request) => request.role === "lead")).toHaveLength(1);
    // Delivered over the socket, so nothing is missed on this device.
    await until(async () => {
      const missed = (await (await call(s, "GET", "/v1/cells/owner/missed")).json()) as {
        messages: unknown[];
      };
      return missed.messages.length === 0;
    });
  });

  it("lists missed answers for a device with no open session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    s.sockets.splice(0);
    await call(s, "GET", "/v1/cells/owner/status");
    await s.cells.get("owner")?.submitInput("owner", "while away", "req-00000002");
    await s.opened[0]?.harness.waitForIdle(BACKGROUND_CONTEXT);
    const missed = (await (await call(s, "GET", "/v1/cells/owner/missed")).json()) as {
      messages: { kind: string; text: string }[];
    };
    expect(missed.messages).toEqual([
      expect.objectContaining({ kind: "answer", text: "lead says: while away" }),
    ]);
  });

  describe("opening a session while the lead commits an answer", () => {
    interface Opening {
      readonly s: Setup;
      readonly cell: PersonCell;
      readonly harness: CellHarness;
      readonly server: FakeSocket;
      /** Whether the held frames of the opening device include an answer or follow-up. */
      readonly held: () => boolean;
    }

    async function opening(): Promise<Opening> {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const s = await setup();
      s.sockets.splice(0);
      const server = new FakeSocket();
      vi.stubGlobal(
        "WebSocketPair",
        class {
          0 = new FakeSocket();
          1 = server;
          constructor() {
            s.sockets.push(server);
          }
        },
      );
      await call(s, "GET", "/v1/cells/owner/status");
      const cell = s.cells.get("owner");
      const harness = s.opened[0];
      if (cell === undefined || harness === undefined) throw new Error("setup failed");
      const handoffs = (cell as unknown as { handoffs: Map<string, { type: string }[]> }).handoffs;
      const held = () =>
        (handoffs.get("laptop") ?? []).some(
          (frame) => frame.type === "answer" || frame.type === "followup",
        );
      return { s, cell, harness, server, held };
    }

    // Node refuses a 101 Response, so the opening settles as a rejection after the work is done.
    const open = (s: Setup) => call(s, "GET", "/v1/cells/owner/session").catch(() => undefined);

    const gate = () => {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };

    const texts = (server: FakeSocket) =>
      server.sent
        .filter((frame) => ["answer", "followup", "missed"].includes(String(frame.type)))
        .map((frame) => String(frame.text));

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("sends an answer that commits after the missed scan read the history, once, and keeps the cursor behind it", async () => {
      const { s, cell, harness, server, held } = await opening();
      const original = harness.missed.bind(harness);
      const scanned = gate();
      const pending = gate();
      vi.spyOn(harness, "missed").mockImplementation(async (device) => {
        const page = await original(device);
        scanned.release();
        await pending.promise;
        return page;
      });
      const session = open(s);
      await scanned.promise;
      await cell.submitInput("owner", "during the scan", "req-00000003");
      await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
      await until(held);
      pending.release();
      await session;
      expect(texts(server)).toEqual(["lead says: during the scan"]);
      // A later live answer must not move the cursor past anything the client was not sent.
      await cell.submitInput("owner", "after the scan", "req-00000004");
      await until(() => texts(server).length === 2);
      expect(texts(server)).toEqual(["lead says: during the scan", "lead says: after the scan"]);
      await until(async () => {
        const page = (await (await call(s, "GET", "/v1/cells/owner/missed")).json()) as {
          messages: unknown[];
        };
        return page.messages.length === 0;
      });
      expect(texts(server)).toHaveLength(2);
    });

    it("sends an answer once when both the missed page and the live watch carry it", async () => {
      const { s, cell, harness, server, held } = await opening();
      const original = harness.missed.bind(harness);
      const reached = gate();
      const pending = gate();
      vi.spyOn(harness, "missed").mockImplementation(async (device) => {
        reached.release();
        await pending.promise;
        return original(device);
      });
      const session = open(s);
      await reached.promise;
      await cell.submitInput("owner", "during the scan", "req-00000005");
      await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
      await until(held);
      pending.release();
      await session;
      expect(texts(server)).toEqual(["lead says: during the scan"]);
      expect(server.sent.filter((frame) => frame.type === "answer")).toHaveLength(0);
      await cell.submitInput("owner", "after the scan", "req-00000006");
      await until(() => texts(server).length === 2);
      expect(texts(server)).toEqual(["lead says: during the scan", "lead says: after the scan"]);
    });
  });

  it("answers a malformed chat frame with an error frame and refuses a session without WebSocket support", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    await call(s, "GET", "/v1/cells/owner/status");
    const socket = s.sockets[0];
    const cell = s.cells.get("owner");
    if (cell === undefined || socket === undefined) throw new Error("setup failed");
    await cell.webSocketMessage(socket, "not json");
    await cell.webSocketMessage(
      socket,
      JSON.stringify({ type: "input", text: "", requestId: "short" }),
    );
    expect(socket.sent.filter((frame) => frame.type === "error")).toHaveLength(2);
    expect((await call(s, "GET", "/v1/cells/owner/session")).status).toBe(501);
    await cell.webSocketClose(socket, 1000);
    expect(socket.closed).toBe(true);
  });

  it("re-arms its alarm after opening and after a chat input, instead of a timed keep-alive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    s.sockets.splice(0);
    await call(s, "GET", "/v1/cells/owner/status");
    const cell = s.cells.get("owner");
    const storage = (cell as unknown as { state: { storage: FakeCelldStorage } }).state.storage;
    await until(async () => (await storage.getAlarm()) !== null);
    await cell?.submitInput("owner", "hello again", "req-00000003");
    await s.opened[0]?.harness.waitForIdle(BACKGROUND_CONTEXT);
    const wakes = await s.opened[0]?.wakes();
    await until(async () => (await storage.getAlarm()) === wakes?.summary.wakes[0]?.at);
    const body = (await (await call(s, "GET", "/v1/cells/owner/status?tasks=1")).json()) as {
      tasks: { kind: string; checkpoint?: { wakeAt: number } }[];
    };
    expect(
      body.tasks.find((task) => task.kind === "secbot.routine:heartbeat")?.checkpoint?.wakeAt,
    ).toBe(wakes?.summary.wakes[0]?.at);
  });

  it("shows live tasks with the hand-off brief on request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const body = (await (await call(s, "GET", "/v1/cells/owner/status?tasks=1")).json()) as {
      tasks: unknown[];
    };
    expect(Array.isArray(body.tasks)).toBe(true);
  });
});
