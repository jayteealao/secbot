// The person cell's routes over the node:sqlite stand-in and a scripted model: status up with
// the version and its roles, the model, tier-cap, and template routes, chat input (which steers a
// busy lead) and frames over a socket, missed messages, and the live job tasks.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CellHarness, JobBoardDoc, openCellHarness, StopDoc } from "@secbot/cell-harness";
import {
  ALTERNATE_MODEL,
  createFauxGateway,
  FakeCelldStorage,
  type FauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  type Responder,
  until,
} from "@secbot/cell-harness/testing";
import { createHold, jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/device-auth.ts";
import { PersonCell, type SocketLike } from "../src/person-cell.ts";
import { route, type WorkerEnv } from "../src/routes.ts";

const KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef";

/** A research job asks the lead; the lead puts the question to the person and asks in its words. */
const asksPerson: Responder = (request) => {
  if (request.role === "research") {
    return request.last?.role === "toolResult"
      ? fauxAssistantMessage([fauxText(`Filled in: ${request.lastText}`)])
      : fauxAssistantMessage([fauxToolCall("ask_lead", { question: "Home or office address?" })], {
          stopReason: "toolUse",
        });
  }
  if (request.lastText.startsWith("[job 1 question:")) {
    return fauxAssistantMessage([fauxToolCall("ask_person", { job: 1 })], {
      stopReason: "toolUse",
    });
  }
  if (request.lastText.startsWith("Ask the person")) {
    return fauxAssistantMessage([fauxText("Which address goes on the form, home or the office?")]);
  }
  return jobResponder(request);
};
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

async function setup(respond?: Responder): Promise<Setup> {
  const gateway = createFauxGateway(respond);
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
  it("reports up with the version and its roles, alone and through /health", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const status = await call(s, "GET", "/v1/cells/owner/status");
    expect(await status.json()).toEqual({
      status: "up",
      person: "owner",
      version: "v0.0.0-test",
      roles: ["lead", "household", "research", "health", "developer"],
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

  it("changes a model and a tier cap, refuses bad ones, and adds a template", async () => {
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
    const withModel = await call(s, "POST", "/v1/cells/owner/specialists", {
      name: "tax",
      instruction: "Forms.",
      model: ALTERNATE_MODEL,
    });
    expect(withModel.status).toBe(400);
    expect(((await withModel.json()) as { error: string }).error).toContain("starts on a tier");
    expect((await (await call(s, "GET", "/v1/cells/owner/status")).json()) as object).toMatchObject(
      { roles: expect.arrayContaining(["garden"]) },
    );
    const cap = await call(s, "PUT", "/v1/cells/owner/tiers/mid/cap", { usd: 2.5 });
    expect(await cap.json()).toEqual({ tier: "mid", capUsd: 2.5 });
    expect((await call(s, "PUT", "/v1/cells/owner/tiers/mid/cap", { usd: 0 })).status).toBe(400);
    expect((await call(s, "PUT", "/v1/cells/owner/tiers/huge/cap", { usd: 1 })).status).toBe(400);
    expect((await call(s, "PUT", "/v1/cells/owner/tiers/mid/cap", {})).status).toBe(400);
    const models = (await (await call(s, "GET", "/v1/cells/owner/models")).json()) as {
      roles: { role: string; capUsd?: number }[];
    };
    expect(models.roles.find((entry) => entry.role === "mid")?.capUsd).toBe(2.5);
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

    async function opening(respond?: Responder): Promise<Opening> {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const s = await setup(respond);
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

    it("sends each open job question after the missed messages, and answers it through the route", async () => {
      const { s, harness, server } = await opening(asksPerson);
      await (
        await harness.submit(
          startJobLine({ title: "renew passport form", brief: "fill it", template: "research" }),
          "q-1",
        )
      ).wait(BACKGROUND_CONTEXT);
      await until(async () => (await harness.board()).jobs["1"]?.question?.toPerson === true);
      await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
      await open(s);
      const kinds = server.sent.map((frame) => String(frame.type));
      const question = kinds.indexOf("question");
      expect(question).toBeGreaterThan(kinds.lastIndexOf("missed"));
      expect(server.sent[question]).toEqual({
        type: "question",
        job: 1,
        title: "renew passport form",
      });
      expect(kinds.filter((kind) => kind === "question")).toHaveLength(1);

      const answer = (n: number, body: unknown) =>
        call(s, "POST", `/v1/cells/owner/jobs/${n}/answer`, body);
      const missing = await answer(9, { text: "home" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "no job #9" });
      expect((await answer(1, { text: "  " })).status).toBe(400);
      expect((await answer(1, { text: "x".repeat(2_001) })).status).toBe(400);
      const answered = await answer(1, { text: "home address" });
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ job: 1, title: "renew passport form" });
      await until(async () => (await harness.board()).jobs["1"]?.status === "done");
      const again = await answer(1, { text: "home address" });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "job 1 has no question waiting" });
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

  it("reopens its harness after the session is poisoned, instead of failing every request until a restart", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup();
    expect((await call(s, "GET", "/v1/cells/owner/status")).status).toBe(200);
    const first = s.opened[0];
    if (first === undefined) throw new Error("no harness opened");
    vi.spyOn(first, "status").mockRejectedValue(
      new Error("Session is poisoned by a failed commit after storage admission; reopen it"),
    );
    // The request that meets the poisoned session fails once.
    await expect(call(s, "GET", "/v1/cells/owner/status")).rejects.toThrow(/poisoned/);
    // The next one opens a new harness on the same storage and answers.
    const again = await call(s, "GET", "/v1/cells/owner/status");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "up", person: "owner" });
    expect(s.opened).toHaveLength(2);
  });

  it("reopens its harness after celld closed the cell's database under it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup();
    expect((await call(s, "GET", "/v1/cells/owner/status")).status).toBe(200);
    const first = s.opened[0];
    if (first === undefined) throw new Error("no harness opened");
    vi.spyOn(first, "status").mockRejectedValue(new Error("SQL error: no db for PersonCell:owner"));
    await expect(call(s, "GET", "/v1/cells/owner/status")).rejects.toThrow(/no db for/);
    const again = await call(s, "GET", "/v1/cells/owner/status");
    expect(again.status).toBe(200);
    expect(s.opened).toHaveLength(2);
  });

  it("keeps its session after celld refuses a storage gate to work whose event ended", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup();
    s.sockets.splice(0);
    await call(s, "GET", "/v1/cells/owner/status");
    const cell = s.cells.get("owner");
    if (cell === undefined) throw new Error("no cell");
    const storage = (cell as unknown as { state: { storage: FakeCelldStorage } }).state.storage;
    await s.opened[0]?.harness.waitForIdle(BACKGROUND_CONTEXT);
    storage.refuseNextGate = true;
    // The refused transaction fails its own operation at most; pi-durable may retry it.
    await cell.submitInput("owner", "hello", "req-gate-0001").catch(() => undefined);
    expect(storage.refuseNextGate).toBe(false);
    // Nothing was written, so the session stays usable: the same harness takes the next line.
    const { submissionId } = await cell.submitInput("owner", "hello", "req-gate-0002");
    expect(submissionId).toBeGreaterThan(0);
    expect((await call(s, "GET", "/v1/cells/owner/status")).status).toBe(200);
    expect(s.opened).toHaveLength(1);
  });

  it("shows live job tasks with their input on request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    const s = await setup(hold.wrap(jobResponder));
    await call(s, "GET", "/v1/cells/owner/status");
    const cell = s.cells.get("owner");
    if (cell === undefined) throw new Error("setup failed");
    await cell.submitInput(
      "owner",
      startJobLine({ title: "a", brief: "look", template: "research" }),
      "req-job-0001",
    );
    await until(() => hold.waiting("research") === 1);
    const body = (await (await call(s, "GET", "/v1/cells/owner/status?tasks=1")).json()) as {
      tasks: { kind: string; input?: unknown }[];
    };
    expect(body.tasks.find((task) => task.kind === "secbot.job")).toMatchObject({
      input: { number: 1 },
    });
    hold.release("research");
  });

  it("steers a busy lead with a chat line; an RPC input waits for the turn unless told", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup(jobResponder);
    await call(s, "GET", "/v1/cells/owner/status");
    const cell = s.cells.get("owner");
    const socket = s.sockets[0];
    if (cell === undefined || socket === undefined) throw new Error("setup failed");
    await cell.webSocketMessage(
      socket,
      JSON.stringify({ type: "input", text: "hello lead", requestId: "req-00000002" }),
    );
    await cell.submitInput("owner", "from mail", "req-mail-0001");
    const steered = loggedEvents(log.mock.calls).filter((e) => e.event === "input.steered");
    expect(steered.map((e) => [e.request_id, e.when_busy])).toEqual([
      ["req-00000002", "steer"],
      ["req-mail-0001", "followUp"],
    ]);
  });
});

describe("the job board, stop, restart, and reorder routes", () => {
  /** Three research jobs, held by the model so they stay running. */
  async function threeJobs() {
    const hold = createHold();
    const s = await setup(hold.wrap(jobResponder));
    s.sockets.splice(0);
    await call(s, "GET", "/v1/cells/owner/status");
    const harness = s.opened[0];
    if (harness === undefined) throw new Error("setup failed");
    hold.hold("research");
    for (const [index, title] of ["flights to Lisbon", "train times", "hotel list"].entries()) {
      await (
        await harness.submit(
          startJobLine({ title, brief: `${title}, please.`, template: "research" }),
          `route-job-${index}`,
        )
      ).wait(BACKGROUND_CONTEXT);
    }
    await until(() => hold.waiting("research") === 3);
    return { s, harness, hold };
  }
  const priority = (s: Setup, n: number, body: unknown) =>
    call(s, "POST", `/v1/cells/owner/jobs/${n}/priority`, body);

  it("answers the board, reorders live jobs, and refuses a bad body, a missing job, and an ended one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { s, harness, hold } = await threeJobs();
    const board = await call(s, "GET", "/v1/cells/owner/jobs");
    expect(board.status).toBe(200);
    const view = (await board.json()) as { person: string; rows: { number: number }[] };
    expect(view.person).toBe("owner");
    expect(view.rows.map((row) => row.number)).toEqual([1, 2, 3]);

    const urgent = await priority(s, 3, { urgent: true });
    expect(urgent.status).toBe(200);
    expect(await urgent.json()).toEqual({
      job: 3,
      title: "hotel list",
      priority: "urgent",
      deadline: null,
      place: 1,
      of: 3,
    });
    expect(await (await priority(s, 2, { deadline: "2026-10-12" })).json()).toMatchObject({
      job: 2,
      priority: "deadline",
      deadline: "2026-10-12",
      place: 2,
      of: 3,
    });
    expect(await (await priority(s, 1, { before: 3 })).json()).toMatchObject({
      job: 1,
      place: 1,
      of: 3,
      before: 3,
    });
    expect(await (await priority(s, 2, { deadline: null })).json()).toMatchObject({
      job: 2,
      priority: "routine",
      deadline: null,
    });
    for (const body of [
      {},
      { urgent: false },
      { deadline: "2026-02-30" },
      { deadline: "12/10/2026" },
      { before: 0 },
      { before: "1" },
      { urgent: true, before: 1 },
    ]) {
      expect((await priority(s, 1, body)).status).toBe(400);
    }
    const missing = await priority(s, 9, { urgent: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no job #9", reason: "no-job", job: 9 });
    const missingTarget = await priority(s, 1, { before: 9 });
    expect(missingTarget.status).toBe(404);
    expect(await missingTarget.json()).toMatchObject({ error: "no job #9" });

    // The stop ends every job: a reorder of one is refused.
    const stopping = call(s, "POST", "/v1/cells/owner/stop");
    await until(
      async () => (await harness.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
    );
    hold.release("research");
    const stopped = await stopping;
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ jobs: 3, turn: false });
    const ended = await priority(s, 1, { urgent: true });
    expect(ended.status).toBe(409);
    expect(await ended.json()).toEqual({ error: "job 1 has ended", reason: "ended", job: 1 });
  }, 60_000);

  it("restarts a stopped job and refuses a missing, a running, and a paused one, and during a stop", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { s, harness, hold } = await threeJobs();
    const stopping = call(s, "POST", "/v1/cells/owner/stop");
    await until(
      async () => (await harness.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
    );
    hold.release("research");
    await stopping;
    const restart = (n: number) => call(s, "POST", `/v1/cells/owner/jobs/${n}/restart`);

    const missing = await restart(9);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no stopped job #9", reason: "no-job" });

    const restarted = await restart(1);
    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toEqual({ job: 1, title: "flights to Lisbon" });
    await until(async () => (await harness.board()).jobs["1"]?.status === "done");
    const again = await restart(1);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "no stopped job #1", reason: "not-stopped" });

    await harness.harness.commit(async (tx) => {
      const board = await tx.doc(JobBoardDoc);
      const row = board.jobs["2"];
      if (row === undefined) throw new Error("no job 2");
      row.status = "paused";
      row.pause = { reason: "cap", at: 1, detail: "" };
    }, BACKGROUND_CONTEXT);
    const paused = await restart(2);
    expect(paused.status).toBe(409);
    expect(await paused.json()).toEqual({
      error: "job 2 is paused, not stopped",
      reason: "paused",
    });

    await harness.harness.commit(async (tx) => {
      (await tx.doc(StopDoc)).active = { at: 1, by: "person" };
    }, BACKGROUND_CONTEXT);
    const locked = await restart(3);
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({
      error: "a stop is running; try again",
      reason: "locked",
    });
  }, 60_000);

  it("answers the owner's board and stop through RPC", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { s, harness, hold } = await threeJobs();
    const cell = s.cells.get("owner");
    if (cell === undefined) throw new Error("setup failed");
    const view = await cell.jobsOf("owner");
    expect(view).toMatchObject({ ok: true, value: { person: "owner", operator: true, live: 3 } });
    const stopping = cell.stopOf("owner");
    await until(
      async () => (await harness.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
    );
    hold.release("research");
    expect(await stopping).toEqual({ ok: true, value: { jobs: 3, turn: false } });
    expect((await harness.board()).jobs["1"]).toMatchObject({
      status: "stopped",
      stop: { by: "owner" },
    });
  }, 60_000);
});
