/**
 * `PersonCell`: one Durable Object per person (named "owner", "second"), hosting that person's
 * pi-durable harness on the cell's own storage. The worker reaches it only after the device check
 * and passes the person and the device name in headers it sets itself.
 *
 * Chat sessions are hibernatable WebSockets: celld delivers each frame a handler sends while the
 * handler still runs (celld v0.6.1 docs/services/durable-objects.md, "Ownership and the
 * single-threaded model"), and a socket closes when the cell moves, so the client reconnects. Every
 * message goes to the lead's root conversation unchanged; the lead alone decides on a hand-off.
 *
 * The cell's one alarm is kept at the earliest durable wake time (routine timers, model retries)
 * and re-armed after every event that can change the tasks. `alarm()` only wakes the cell: opening
 * the harness resumes every due task from its checkpoint.
 */
import { BACKGROUND_CONTEXT as cellContext } from "@earendil-works/chord/context";
import {
  alarmVerdict,
  CellAlarm,
  type CellEnv,
  type CellHarness,
  type Frame,
  type HouseholdApplyResult,
  type HouseholdChange,
  type HouseholdClient,
  type HouseholdDocument,
  openCellHarness,
  RefusedChange,
  type SessionStream,
} from "@secbot/cell-harness";
import type { CelldAlarmInfo, CelldCellStorage } from "@secbot/cell-storage";
import { HOUSEHOLD_CELL_NAME } from "@secbot/household-cell";
import { releaseVersion } from "./health.ts";

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PersonCellState {
  readonly storage: CelldCellStorage;
  acceptWebSocket?(socket: SocketLike, tags?: string[]): void;
  getWebSockets?(tag?: string): SocketLike[];
  getTags?(socket: SocketLike): string[];
  waitUntil?(promise: Promise<unknown>): void;
}

/** The household cell's RPC surface, as a stub from the `HOUSEHOLD_CELL` binding exposes it. */
export interface HouseholdStubLike extends HouseholdClient {
  history?(document: string, itemId?: string): Promise<unknown>;
  status?(): Promise<{ status: "up"; version: string; roles: string[] }>;
  alarmReport?(): Promise<unknown>;
}

export interface HouseholdNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): HouseholdStubLike;
}

export interface PersonCellEnv extends CellEnv {
  readonly HOUSEHOLD_CELL?: HouseholdNamespaceLike;
}

/** What the cell gives the harness it opens. */
export interface OpenExtras {
  readonly household?: HouseholdClient;
  readonly onWakeChange: () => void;
}

export interface PersonCellOptions {
  /** Tests: how often a settling cell looks at its tasks (2 s in a cell). */
  readonly pollMs?: number;
  /** Tests: a clock; defaults to Date.now. */
  readonly now?: () => number;
}

/** Headers the worker sets after the device check; any client copy is removed first. */
export const PERSON_HEADER = "x-secbot-person";
export const DEVICE_HEADER = "x-secbot-device";

export const householdOf = (env: {
  readonly HOUSEHOLD_CELL?: HouseholdNamespaceLike;
}): HouseholdStubLike | undefined =>
  env.HOUSEHOLD_CELL?.get(env.HOUSEHOLD_CELL.idFromName(HOUSEHOLD_CELL_NAME));

type InputFrame = { readonly type: "input"; readonly text: string; readonly requestId: string };

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const PERSON = /^[a-z][a-z0-9-]{0,31}$/;
const NAME_TABLE =
  "CREATE TABLE IF NOT EXISTS secbot_cell_name (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL)";

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
  private alarms: CellAlarm | undefined;
  private knownName: string | undefined;

  constructor(
    private readonly state: PersonCellState,
    private readonly env: PersonCellEnv,
    /** Tests: opens the harness with a scripted model in place of the gateway. celld passes two arguments. */
    private readonly open: (
      storage: CelldCellStorage,
      person: string,
      extras: OpenExtras,
    ) => Promise<CellHarness> = (storage, person, extras) =>
      openCellHarness(storage, { person, version: releaseVersion(), env, ...extras }),
    private readonly options: PersonCellOptions = {},
  ) {}

  /** Remembers which person this cell is, so an alarm (which carries no request) can open it. */
  private rememberName(person: string): void {
    if (this.knownName === person) return;
    const sql = this.state.storage.sql;
    sql.exec(NAME_TABLE).toArray();
    const stored = sql.exec("SELECT name FROM secbot_cell_name WHERE id = 1").toArray()[0]?.name;
    if (stored !== person) {
      sql
        .exec("INSERT OR REPLACE INTO secbot_cell_name (id, name) VALUES (1, ?)", person)
        .toArray();
    }
    this.knownName = person;
  }

  private storedName(): string | undefined {
    if (this.knownName !== undefined) return this.knownName;
    const sql = this.state.storage.sql;
    sql.exec(NAME_TABLE).toArray();
    const name = sql.exec("SELECT name FROM secbot_cell_name WHERE id = 1").toArray()[0]?.name;
    if (typeof name === "string" && PERSON.test(name)) this.knownName = name;
    return this.knownName;
  }

  /** The cell's name is known only once the first event (or the stored name) gives it. */
  private alarmFor(person: string): CellAlarm {
    this.alarms ??= new CellAlarm(this.state.storage, person, {
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.pollMs === undefined ? {} : { pollMs: this.options.pollMs }),
    });
    return this.alarms;
  }

  /**
   * Opens the harness once per activation; a failed open is retried by the next event. After the
   * open the alarm is set again from the stored timers.
   */
  private cell(person: string): Promise<CellHarness> {
    if (this.opening === undefined) {
      this.rememberName(person);
      const household = householdOf(this.env);
      this.opening = this.open(this.state.storage, person, {
        ...(household === undefined ? {} : { household: clientOf(household) }),
        onWakeChange: () => this.rearmSoon(person),
      }).then(async (cell) => {
        await this.alarmFor(person).rearm(cell);
        // Work the open resumed (or the roster just created) settles; re-arm once it has.
        this.keepBusy(cell);
        return cell;
      });
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private rearmSoon(person: string): void {
    const opening = this.opening;
    if (opening === undefined) return;
    const work = opening.then((cell) => this.alarmFor(person).rearm(cell)).catch(() => {});
    this.state.waitUntil?.(work);
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

  /**
   * Keeps the cell busy while due or untimed work runs (a hand-off, a model call), re-arming as it
   * goes. No ceiling on the work: when the event ends first, the alarm's liveness wake (one minute
   * ahead while such work is live) brings the cell back to finish it.
   */
  private keepBusy(cell: CellHarness): void {
    const alarms = this.alarmFor(cell.person);
    if (alarms.isSettling) return;
    const work = alarms.settle(cell).catch(() => {});
    if (this.state.waitUntil === undefined) return;
    this.state.waitUntil(work);
  }

  /** celld calls this when the alarm is due, also on an idle or evicted cell. */
  async alarm(info?: CelldAlarmInfo): Promise<void> {
    const person = this.storedName();
    if (person === undefined) return;
    const alarms = this.alarmFor(person);
    alarms.fired(info, undefined);
    const cell = await this.cell(person);
    // Wait while the due work runs: a routine fires, a reminder reaches the lead and is relayed.
    if (this.sockets().length > 0) await this.ensureStream(cell);
    await alarms.settle(cell);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const person = request.headers.get(PERSON_HEADER) ?? "";
    const device = request.headers.get(DEVICE_HEADER) ?? "";
    const prefix = `/v1/cells/${person}`;
    if (!PERSON.test(person) || !url.pathname.startsWith(`${prefix}/`))
      return json({ error: "not found" }, 404);
    const route = url.pathname.slice(prefix.length);
    if (request.method === "GET" && route === "/alarm") {
      // The stored alarm is read before anything else, and this route never re-arms it. Waking an
      // evicted cell to answer opens its harness, and an open re-arms (a cell that was never
      // opened gets its first alarm then), so the next check sees the result.
      const alarm = await this.state.storage.getAlarm();
      const cell = await this.cell(person);
      const { summary } = await cell.wakes();
      return json(alarmVerdict(person, alarm, summary));
    }
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
          ...(record.kind.startsWith("secbot.routine:") &&
          record.state.status !== "terminal" &&
          record.state.status !== "completing"
            ? { checkpoint: record.state.checkpoint }
            : {}),
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
        this.rearmSoon(person);
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

  /** RPC for other cells and later packets (mail): submit into the lead, unchanged. */
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

  /** RPC (test-cell lab): this person cell reads a household document through its own client. */
  async householdRead(document: string): Promise<HouseholdDocument> {
    const household = householdOf(this.env);
    if (household === undefined) throw new Error("no HOUSEHOLD_CELL binding");
    return household.read(document);
  }

  /** RPC (test-cell lab): this person cell changes a household document as `person`. */
  async householdChange(person: string, change: HouseholdChange): Promise<HouseholdApplyResult> {
    const household = householdOf(this.env);
    if (household === undefined) throw new Error("no HOUSEHOLD_CELL binding");
    return household.apply({ ...change, fromCell: person });
  }
}

/** A plain client over the stub, so the harness never holds the stub itself. */
function clientOf(stub: HouseholdStubLike): HouseholdClient {
  return {
    read: (document) => stub.read(document),
    apply: (change) => stub.apply(change),
  };
}
