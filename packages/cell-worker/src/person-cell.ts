/**
 * `PersonCell`: one Durable Object per person (named "owner", "second"), hosting that person's
 * pi-durable harness on the cell's own storage. The worker reaches it only after the device check
 * and passes the person and the device name in headers it sets itself.
 *
 * Chat sessions are hibernatable WebSockets: celld delivers each frame a handler sends while the
 * handler still runs (celld v0.6.1 docs/services/durable-objects.md, "Ownership and the
 * single-threaded model"), and a socket closes when the cell moves, so the client reconnects. Every
 * message goes to the lead's root conversation unchanged; the lead alone decides on a hand-off.
 */
import { BACKGROUND_CONTEXT as cellContext } from "@earendil-works/chord/context";
import {
  type CellEnv,
  type CellHarness,
  type Frame,
  openCellHarness,
  RefusedChange,
  type SessionStream,
} from "@secbot/cell-harness";
import type { CelldStorage } from "@secbot/cell-storage";
import { releaseVersion } from "./health.ts";

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PersonCellState {
  readonly storage: CelldStorage;
  acceptWebSocket?(socket: SocketLike, tags?: string[]): void;
  getWebSockets?(tag?: string): SocketLike[];
  getTags?(socket: SocketLike): string[];
  waitUntil?(promise: Promise<unknown>): void;
}

export type PersonCellEnv = CellEnv;

/** Headers the worker sets after the device check; any client copy is removed first. */
export const PERSON_HEADER = "x-secbot-person";
export const DEVICE_HEADER = "x-secbot-device";

/** How long the cell keeps itself busy while background work (a hand-off) runs. */
const BUSY_LIMIT_MS = 30 * 60_000;

type InputFrame = { readonly type: "input"; readonly text: string; readonly requestId: string };

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function parseInput(data: string | ArrayBuffer): InputFrame | undefined {
  try {
    const value = JSON.parse(
      typeof data === "string" ? data : new TextDecoder().decode(data),
    ) as Record<string, unknown>;
    if (
      value.type !== "input" ||
      typeof value.text !== "string" ||
      typeof value.requestId !== "string"
    ) {
      return undefined;
    }
    if (
      value.text.trim() === "" ||
      value.text.length > 20_000 ||
      !REQUEST_ID.test(value.requestId)
    ) {
      return undefined;
    }
    return { type: "input", text: value.text, requestId: value.requestId };
  } catch {
    return undefined;
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export class PersonCell {
  private opening: Promise<CellHarness> | undefined;
  private streaming: Promise<SessionStream> | undefined;
  private readonly framesSent = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly state: PersonCellState,
    env: PersonCellEnv,
    /** Tests: opens the harness with a scripted model in place of the gateway. celld passes two arguments. */
    private readonly open: (storage: CelldStorage, person: string) => Promise<CellHarness> = (
      storage,
      person,
    ) => openCellHarness(storage, { person, version: releaseVersion(), env }),
  ) {}

  /** Opens the harness once per activation; a failed open is retried by the next event. */
  private cell(person: string): Promise<CellHarness> {
    if (this.opening === undefined) {
      this.opening = this.open(this.state.storage, person);
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private sockets(): SocketLike[] {
    return this.state.getWebSockets?.() ?? [];
  }

  private tagsOf(socket: SocketLike): { device: string; person: string } {
    const [device = "unknown", person = "owner"] = this.state.getTags?.(socket) ?? [];
    return { device, person };
  }

  private broadcast(frame: Frame): void {
    const text = JSON.stringify(frame);
    for (const socket of this.sockets()) {
      try {
        socket.send(text);
        const { device } = this.tagsOf(socket);
        this.framesSent.set(device, (this.framesSent.get(device) ?? 0) + 1);
      } catch {
        // A closed socket; its client reconnects and reads `missed`.
      }
    }
  }

  /** One watch of the lead per activation, fanned out to every open socket. */
  private ensureStream(cell: CellHarness): Promise<SessionStream> {
    if (this.streaming === undefined) {
      this.streaming = cell.session(
        (frame) => this.broadcast(frame),
        async (entryId) => {
          const devices = new Set(this.sockets().map((socket) => this.tagsOf(socket).device));
          for (const device of devices) await cell.markDelivered(device, entryId);
        },
      );
      this.streaming.catch(() => {
        this.streaming = undefined;
      });
    }
    return this.streaming;
  }

  /** Keeps the cell busy while tasks are live, so a background hand-off is not cut off. */
  private keepBusy(cell: CellHarness): void {
    if (this.busy || this.state.waitUntil === undefined) return;
    this.busy = true;
    const until = Date.now() + BUSY_LIMIT_MS;
    // sdlc-debt: polls the task list every 2 s for up to 30 minutes; the alarm wake that resumes an
    // evicted cell arrives with routine timers, which replaces this keep-alive.
    const poll = async () => {
      while (Date.now() < until && (await cell.harness.inspect(cellContext)).tasks.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      this.busy = false;
    };
    this.state.waitUntil(poll().catch(() => (this.busy = false)));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const person = request.headers.get(PERSON_HEADER) ?? "";
    const device = request.headers.get(DEVICE_HEADER) ?? "";
    const prefix = `/v1/cells/${person}`;
    if (person === "" || !url.pathname.startsWith(`${prefix}/`))
      return json({ error: "not found" }, 404);
    const route = url.pathname.slice(prefix.length);
    const cell = await this.cell(person);
    try {
      if (request.method === "GET" && route === "/status") {
        const status = await cell.status();
        if (url.searchParams.get("tasks") !== "1") return json(status);
        const inspection = await cell.harness.inspect(cellContext);
        const tasks = inspection.tasks.map(({ record, state }) => ({
          id: record.id,
          kind: record.kind,
          conversationId: record.conversationId,
          background: record.background ?? false,
          state: state.kind,
          ...(record.kind === "secbot.handoff-reporter" ? { input: record.input } : {}),
        }));
        return json({ ...status, tasks });
      }
      if (request.method === "GET" && route === "/session")
        return this.openSession(cell, person, device);
      if (request.method === "GET" && route === "/missed") {
        return json({ messages: await cell.missed(device) });
      }
      if (request.method === "GET" && route === "/models") {
        return json({ roles: await cell.listRoleModels() });
      }
      const modelRoute = /^\/models\/([a-z][a-z0-9-]{0,31})$/.exec(route);
      if (request.method === "PUT" && modelRoute !== null) {
        const body = (await request.json().catch(() => ({}))) as { model?: unknown };
        if (typeof body.model !== "string") return json({ error: 'send {"model": "<id>"}' }, 400);
        return json(await cell.setRoleModel(modelRoute[1] ?? "", body.model));
      }
      if (request.method === "POST" && route === "/specialists") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof body.name !== "string" || typeof body.instruction !== "string") {
          return json({ error: "send name and instruction" }, 400);
        }
        await cell.addSpecialist({
          name: body.name,
          instruction: body.instruction,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
        });
        return json({ name: body.name, status: "added" }, 201);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof RefusedChange) return json({ error: error.message }, 400);
      throw error;
    }
  }

  private async openSession(cell: CellHarness, person: string, device: string): Promise<Response> {
    const Pair = (globalThis as { WebSocketPair?: new () => { 0: SocketLike; 1: SocketLike } })
      .WebSocketPair;
    if (Pair === undefined || this.state.acceptWebSocket === undefined) {
      return json({ error: "this runtime has no WebSocket support" }, 501);
    }
    const pair = new Pair();
    this.state.acceptWebSocket(pair[1], [device, person]);
    pair[1].send(JSON.stringify({ type: "connected", lead: person } satisfies Frame));
    this.framesSent.set(device, 1);
    await this.ensureStream(cell);
    console.log(
      JSON.stringify({ event: "cli.session", cell: person, device, phase: "open", frames_sent: 1 }),
    );
    const init: ResponseInit & { webSocket: SocketLike } = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  }

  /** One chat line from a socket: submitted to the lead unchanged, acknowledged by request id. */
  async webSocketMessage(socket: SocketLike, data: string | ArrayBuffer): Promise<void> {
    const { person } = this.tagsOf(socket);
    const input = parseInput(data);
    if (input === undefined) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: "send {type: input, text, requestId}",
        } satisfies Frame),
      );
      return;
    }
    const cell = await this.cell(person);
    await this.ensureStream(cell);
    await this.submitInput(person, input.text, input.requestId);
    socket.send(JSON.stringify({ type: "accepted", requestId: input.requestId } satisfies Frame));
  }

  async webSocketClose(socket: SocketLike, code: number): Promise<void> {
    const { device, person } = this.tagsOf(socket);
    console.log(
      JSON.stringify({
        event: "cli.session",
        cell: person,
        device,
        phase: "close",
        code,
        frames_sent: this.framesSent.get(device) ?? 0,
      }),
    );
    try {
      socket.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }

  /** RPC for other cells and later packets (mail, reminders): submit into the lead, unchanged. */
  async submitInput(
    person: string,
    text: string,
    requestId: string,
  ): Promise<{ submissionId: number }> {
    const cell = await this.cell(person);
    const submission = await cell.submit(text, requestId);
    this.keepBusy(cell);
    return { submissionId: Number(submission.id) };
  }
}
