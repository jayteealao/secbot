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
 *
 * Snapshots (`snapshot`, `restore`, `wipe`, `digest`) are RPC for the worker's operator routes. A
 * restore closes the harness, loads the dump in one transaction checked against its digest, and
 * reopens it, which resumes the restored tasks and re-arms the alarm from the restored timers.
 */
import { BACKGROUND_CONTEXT as cellContext } from "@earendil-works/chord/context";
import {
  AlwaysNotOffered,
  alarmVerdict,
  CELL_NAME,
  CellAlarm,
  type CellEnv,
  type CellHarness,
  errorFields,
  type Frame,
  type HeartbeatState,
  HeldCallAnswered,
  HeldCallLapsed,
  type HouseholdApplyResult,
  type HouseholdChange,
  type HouseholdClient,
  type HouseholdDocument,
  heartbeatState,
  isDecisionAdapter,
  isGuardMode,
  logEvent,
  MONTH,
  NoHeldCall,
  openCellHarness,
  RefusedChange,
  type Rule,
  type RuleLevel,
  RuleNotFound,
  type SessionStream,
} from "@secbot/cell-harness";
import {
  type CellDump,
  type CelldAlarmInfo,
  type CelldCellStorage,
  CellSnapshots,
} from "@secbot/cell-storage";
import { HOUSEHOLD_CELL_NAME } from "@secbot/household-cell";
import { releaseVersion } from "./health.ts";
import { type HouseholdClientEnv, householdClientOf } from "./household-client.ts";

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

export interface PersonCellEnv extends CellEnv, HouseholdClientEnv {
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
const PERSON = CELL_NAME;
const NAME_TABLE =
  "CREATE TABLE IF NOT EXISTS secbot_cell_name (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL)";

/** The longest chat line the cell accepts; the CLI checks the same limit before sending. */
export const INPUT_LIMIT = 20_000;

/** The largest JSON body the model and specialist routes read. */
export const BODY_LIMIT = 16 * 1024;

type ParsedInput =
  | { readonly ok: true; readonly input: InputFrame }
  | { readonly ok: false; readonly reason: string; readonly requestId?: string };

function parseInput(data: string | ArrayBuffer): ParsedInput {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, reason: "not JSON: send {type: input, text, requestId}" };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "send {type: input, text, requestId}" };
  }
  const requestId =
    typeof value.requestId === "string" && REQUEST_ID.test(value.requestId)
      ? value.requestId
      : undefined;
  const refuse = (reason: string): ParsedInput =>
    requestId === undefined ? { ok: false, reason } : { ok: false, reason, requestId };
  if (value.type !== "input" || typeof value.text !== "string") {
    return refuse("send {type: input, text, requestId}");
  }
  if (requestId === undefined)
    return refuse("a requestId of 8-128 letters, digits, or ._:- is required");
  if (value.text.trim() === "") return refuse("the message is empty");
  if (value.text.length > INPUT_LIMIT) {
    return refuse(`the message is longer than ${INPUT_LIMIT} characters`);
  }
  return { ok: true, input: { type: "input", text: value.text, requestId } };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * A guard answer for RPC and routes alike: the value, or a status and a reason. RPC returns it
 * instead of throwing, so a refusal keeps its status and text across the celld RPC boundary.
 */
export type GuardAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** Activity query parameters, checked: month YYYY-MM, before >= 0, limit 1-200. */
export function activityQuery(
  params: URLSearchParams,
): { month?: string; before?: number; limit?: number } | { error: string } {
  const month = params.get("month");
  const before = params.get("before");
  const limit = params.get("limit");
  if (month !== null && !MONTH.test(month)) return { error: "month must be YYYY-MM" };
  if (before !== null && !/^\d{1,9}$/.test(before)) return { error: "before must be a number" };
  if (limit !== null && !(/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 200)) {
    return { error: "limit must be 1-200" };
  }
  return {
    ...(month === null ? {} : { month }),
    ...(before === null ? {} : { before: Number(before) }),
    ...(limit === null ? {} : { limit: Number(limit) }),
  };
}

/** Runs a rule or activity call; refusals become 400 ("refused: …"), a missing rule 404. */
async function guardAnswer<T>(work: () => Promise<T>): Promise<GuardAnswer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof RuleNotFound) return { ok: false, status: 404, error: error.message };
    if (error instanceof RefusedChange) {
      return { ok: false, status: 400, error: `refused: ${error.message}` };
    }
    throw error;
  }
}

/** The owner's view of a cell's guard mode (`GET|PUT /ops/mode`, `PUT /ops/decision-model`). */
export interface GuardModeAnswer {
  readonly person: string;
  readonly mode: "shadow" | "enforce";
  readonly since: number | null;
  readonly switchedBy: string | null;
  readonly decisionModel: string;
  readonly timeZone: string;
  readonly changed?: boolean;
}

const modeAnswer = (
  person: string,
  cell: CellHarness,
  state: Awaited<ReturnType<CellHarness["guardMode"]>>,
): GuardModeAnswer => ({
  person,
  mode: state.mode,
  since: state.since,
  switchedBy: state.switchedBy,
  decisionModel: state.decisionModel,
  timeZone: cell.timeZone,
});

const answerJson = <T>(
  answer: GuardAnswer<T>,
  status = 200,
  wrap: (value: T) => unknown = (v) => v,
) => (answer.ok ? json(wrap(answer.value), status) : json({ error: answer.error }, answer.status));

/** Reads a JSON body of at most BODY_LIMIT characters; undefined when it is larger or not JSON. */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > BODY_LIMIT) return undefined;
  const text = await request.text().catch(() => "");
  if (text.length > BODY_LIMIT) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class PersonCell {
  private opening: Promise<CellHarness> | undefined;
  private streaming: Promise<SessionStream> | undefined;
  private readonly framesSent = new Map<string, number>();
  /**
   * Frames held back for a device whose session is still opening: its missed page goes first, then
   * these, so a live frame never overtakes the missed scan and never advances the device's cursor
   * before the client was sent what lies behind it.
   */
  private readonly handoffs = new Map<string, Frame[]>();
  private alarms: CellAlarm | undefined;
  private knownName: string | undefined;
  private snapshotOps: CellSnapshots | undefined;
  /** The devices whose socket took the last answer or follow-up frame. */
  private lastSentDevices = new Set<string>();

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
  /** Snapshot, restore, wipe, and digest, shared with the household cell. */
  private snapshots(): CellSnapshots {
    this.snapshotOps ??= new CellSnapshots(
      this.state.storage,
      {
        openDatabase: async () => {
          const opening = this.opening;
          return opening === undefined ? undefined : (await opening).database;
        },
        close: () => this.closeHarness(),
      },
      this.options.now ?? Date.now,
    );
    return this.snapshotOps;
  }

  private cell(person: string): Promise<CellHarness> {
    if (this.opening === undefined) {
      this.rememberName(person);
      const household = householdClientOf(this.env);
      // A restore or wipe in progress finishes first, so the harness opens on the new database.
      this.opening = this.snapshots()
        .idle()
        .then(() =>
          this.open(this.state.storage, person, {
            ...(household === undefined ? {} : { household }),
            onWakeChange: () => this.rearmSoon(person),
          }),
        )
        .then(async (cell) => {
          try {
            await this.alarmFor(person).rearm(cell);
          } catch (error) {
            // An opened harness must not stay running while the next event opens another one.
            await cell.close().catch(() => {});
            throw error;
          }
          // Work the open resumed (or the roster just created) settles; re-arm once it has.
          this.keepBusy(cell);
          return cell;
        });
      const opening = this.opening;
      opening.catch((error: unknown) => {
        if (this.opening === opening) this.opening = undefined;
        logEvent("cell.open_failed", { cell: person, ...errorFields(error) }, "error");
      });
    }
    return this.opening;
  }

  private rearmSoon(person: string): void {
    const opening = this.opening;
    if (opening === undefined) return;
    const work = opening
      .then((cell) => this.alarmFor(person).rearm(cell))
      .catch((error: unknown) => {
        // The wake path: a cell with no alarm sleeps through its timers, so the failure is logged.
        logEvent("alarm.rearm_failed", { cell: person, ...errorFields(error) }, "error");
      });
    this.state.waitUntil?.(work);
  }

  private sockets(): SocketLike[] {
    return this.state.getWebSockets?.() ?? [];
  }

  private tagsOf(socket: SocketLike): { device: string; person: string } {
    const [device = "unknown", person = "owner"] = this.state.getTags?.(socket) ?? [];
    return { device, person };
  }

  /** Sends a frame to every open socket; returns the devices whose socket took it. */
  private broadcast(frame: Frame): Set<string> {
    const text = JSON.stringify(frame);
    const sent = new Set<string>();
    for (const socket of this.sockets()) {
      const { device } = this.tagsOf(socket);
      const held = this.handoffs.get(device);
      if (held !== undefined) {
        // Not sent yet, so not counted as delivered: the session open sends it after the missed page.
        held.push(frame);
        continue;
      }
      try {
        socket.send(text);
        sent.add(device);
        this.framesSent.set(device, (this.framesSent.get(device) ?? 0) + 1);
      } catch {
        // A closed socket; its client reconnects and gets the message as a missed frame.
      }
    }
    if (frame.type === "answer" || frame.type === "followup") this.lastSentDevices = sent;
    return sent;
  }

  /** One watch of the lead per activation, fanned out to every open socket. */
  private ensureStream(cell: CellHarness): Promise<SessionStream> {
    if (this.streaming === undefined) {
      this.streaming = cell.session(
        (frame) => {
          this.broadcast(frame);
        },
        async (entryId) => {
          // Only devices whose socket took the frame count it as delivered; a send that failed on
          // a closing socket leaves the message in that device's missed list.
          for (const device of this.lastSentDevices) await cell.markDelivered(device, entryId);
        },
      );
      const streaming = this.streaming;
      streaming.catch((error: unknown) => {
        if (this.streaming === streaming) this.streaming = undefined;
        logEvent("cli.stream_failed", { cell: cell.person, ...errorFields(error) }, "error");
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
    const work = alarms.settle(cell).catch((error: unknown) => {
      // Due routines and hand-offs may be left unrun; the next event or alarm settles again.
      logEvent("cell.settle_failed", { cell: cell.person, ...errorFields(error) }, "error");
    });
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
        return json(await cell.missed(device));
      }
      if (request.method === "GET" && route === "/models") {
        return json({ roles: await cell.listRoleModels() });
      }
      const modelRoute = /^\/models\/([a-z][a-z0-9-]{0,31})$/.exec(route);
      if (request.method === "PUT" && modelRoute !== null) {
        const body = await readJson(request);
        if (body === undefined) return json({ error: `the body is over ${BODY_LIMIT} bytes` }, 413);
        if (typeof body.model !== "string") return json({ error: 'send {"model": "<id>"}' }, 400);
        return json(await cell.setRoleModel(modelRoute[1] ?? "", body.model));
      }
      if (request.method === "POST" && route === "/specialists") {
        const body = await readJson(request);
        if (body === undefined) return json({ error: `the body is over ${BODY_LIMIT} bytes` }, 413);
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
      if (route === "/rules") return this.rulesRoute(request, cell, "person");
      if (request.method === "GET" && route === "/approvals") {
        return json({ held: await cell.heldCalls() });
      }
      const approvalRoute = /^\/approvals\/([1-9][0-9]{0,8})$/.exec(route);
      if (request.method === "POST" && approvalRoute !== null) {
        return this.answerRoute(request, cell, Number(approvalRoute[1]), device);
      }
      if (request.method === "GET" && route === "/activity") {
        const query = activityQuery(url.searchParams);
        if ("error" in query) return json({ error: query.error }, 400);
        return json({ person, ...(await cell.activity(query)) });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof RefusedChange) return json({ error: error.message }, 400);
      throw error;
    }
  }

  /**
   * GET lists both levels; POST adds one rule (body: agent, tool, verdict, match?); DELETE removes
   * the rule with the body's agent, tool, and match. A device key edits only the person's level.
   */
  private async rulesRoute(request: Request, cell: CellHarness, level: RuleLevel) {
    if (request.method === "GET") return json({ ...(await cell.rules()), timeZone: cell.timeZone });
    if (request.method !== "POST" && request.method !== "DELETE") {
      return json({ error: "not found" }, 404);
    }
    const body = await readJson(request);
    if (body === undefined) return json({ error: `the body is over ${BODY_LIMIT} bytes` }, 413);
    if (request.method === "POST") {
      return answerJson(await guardAnswer(() => cell.addRule(level, body)), 201, (rule) => ({
        rule,
      }));
    }
    return answerJson(await guardAnswer(() => cell.removeRule(level, body)), 200, (removed) => ({
      removed,
    }));
  }

  /**
   * One answer to a held call, from a device of this person: `{"answer": "allow" | "always" |
   * "deny"}`. The same route serves the command line now and the app later.
   */
  private async answerRoute(
    request: Request,
    cell: CellHarness,
    number: number,
    device: string,
  ): Promise<Response> {
    const body = await readJson(request);
    if (body === undefined) return json({ error: `the body is over ${BODY_LIMIT} bytes` }, 413);
    const choice = body.answer;
    if (choice !== "allow" && choice !== "always" && choice !== "deny") {
      return json({ error: 'send {"answer": "allow" | "always" | "deny"}' }, 400);
    }
    try {
      const answered = await cell.answer(number, choice, { device });
      // The waiting call continues in this activation; keep the cell up while it runs.
      this.keepBusy(cell);
      this.rearmSoon(cell.person);
      return json({
        number,
        status: answered.call.status,
        answer: choice,
        agent: answered.call.agent,
        tool: answered.call.tool,
        summary: answered.call.summary,
        answeredBy: answered.answeredBy,
        rule: answered.rule,
      });
    } catch (error) {
      if (error instanceof NoHeldCall) return json({ error: error.message }, 404);
      if (error instanceof HeldCallLapsed) return json({ error: "lapsed" }, 409);
      if (error instanceof HeldCallAnswered) return json({ error: "answered" }, 409);
      if (error instanceof AlwaysNotOffered) {
        return json({ error: `refused: ${error.message}` }, 400);
      }
      if (error instanceof RefusedChange) return json({ error: `refused: ${error.message}` }, 400);
      throw error;
    }
  }

  /** RPC (operator routes): both levels of a person's rules. */
  async ownerRules(
    person: string,
  ): Promise<GuardAnswer<{ owner: Rule[]; person: Rule[]; timeZone: string }>> {
    const cell = await this.cell(person);
    return guardAnswer(async () => {
      const rules = await cell.rules();
      return { owner: [...rules.owner], person: [...rules.person], timeZone: cell.timeZone };
    });
  }

  /** RPC (operator routes): adds an owner rule for this person's agents. */
  async addOwnerRule(person: string, input: unknown): Promise<GuardAnswer<Rule>> {
    const cell = await this.cell(person);
    return guardAnswer(() => cell.addRule("owner", input));
  }

  /** RPC (operator routes): removes an owner rule; the release rule cannot be removed. */
  async removeOwnerRule(person: string, input: unknown): Promise<GuardAnswer<Rule>> {
    const cell = await this.cell(person);
    return guardAnswer(() => cell.removeRule("owner", input));
  }

  /** RPC (operator routes): a person's activity for the owner. */
  async activityOf(
    person: string,
    query: { month?: string; before?: number; limit?: number },
  ): Promise<GuardAnswer<Record<string, unknown>>> {
    const cell = await this.cell(person);
    return guardAnswer(async () => ({ person, ...(await cell.activity(query)) }));
  }

  /** RPC (operator routes): the guard mode, since when, and the decision model, for the owner. */
  async guardModeOf(person: string): Promise<GuardAnswer<GuardModeAnswer>> {
    const cell = await this.cell(person);
    return guardAnswer(async () => modeAnswer(person, cell, await cell.guardMode()));
  }

  /** RPC (operator routes): the owner switches the mode; the next marked call uses it. */
  async setGuardModeOf(person: string, mode: unknown): Promise<GuardAnswer<GuardModeAnswer>> {
    const cell = await this.cell(person);
    return guardAnswer(async () => {
      if (!isGuardMode(mode)) throw new RefusedChange('send {"mode": "shadow" | "enforce"}');
      const switched = await cell.setGuardMode(mode, "owner");
      const state = await cell.guardMode();
      return { ...modeAnswer(person, cell, state), changed: switched.changed };
    });
  }

  /** RPC (operator routes): the owner switches the decision model; the next call uses it. */
  async setDecisionModelOf(
    person: string,
    adapter: unknown,
  ): Promise<GuardAnswer<GuardModeAnswer>> {
    const cell = await this.cell(person);
    return guardAnswer(async () => {
      if (!isDecisionAdapter(adapter)) {
        throw new RefusedChange('send {"adapter": "clef" | "jev"}');
      }
      await cell.setDecisionAdapter(adapter);
      return modeAnswer(person, cell, await cell.guardMode());
    });
  }

  private async openSession(cell: CellHarness, person: string, device: string): Promise<Response> {
    const Pair = (globalThis as { WebSocketPair?: new () => { 0: SocketLike; 1: SocketLike } })
      .WebSocketPair;
    if (Pair === undefined || this.state.acceptWebSocket === undefined) {
      return json({ error: "this runtime has no WebSocket support" }, 501);
    }
    // The live watch is registered before the missed scan, and frames for this device are held until
    // the missed page is sent: an event that commits while the scan runs is then in the page, in the
    // held frames, or both (sent once), never in neither.
    const held: Frame[] = [];
    this.handoffs.set(device, held);
    const pair = new Pair();
    let framesSent = 0;
    const deliver = (frame: Frame) => {
      pair[1].send(JSON.stringify(frame));
      framesSent++;
    };
    let delivered = 0;
    try {
      this.state.acceptWebSocket(pair[1], [device, person]);
      deliver({ type: "connected", lead: person });
      await this.ensureStream(cell);
      // Calls waiting for the person come first, then what the lead said while this device had no
      // open socket, oldest first, so an answer that committed during a reconnect is shown before
      // the next live answer moves the device's cursor past it.
      const { held: waiting, messages, remaining } = await cell.missed(device);
      const shown = new Set(waiting.map((call) => call.number));
      for (const call of waiting) deliver({ type: "held", call, count: waiting.length });
      for (const message of messages) {
        deliver({
          type: "missed",
          entryId: message.entryId,
          from: message.kind === "followup" ? message.from : null,
          text: message.text,
          remaining,
        });
      }
      delivered = messages.length;
      // Held frames follow, minus what the missed page carried. While older messages are still left
      // for `missed`, a held answer stays there too: sending it would move the cursor past them.
      // This runs without an await, so nothing is added to `held` meanwhile.
      const inPage = messages.at(-1)?.entryId ?? -1;
      let deltas: Frame[] = [];
      let newest: number | undefined;
      for (const frame of held) {
        if (frame.type === "delta") {
          deltas.push(frame);
        } else if (frame.type === "answer" || frame.type === "followup") {
          if (frame.entryId > inPage && remaining === 0) {
            for (const delta of deltas) deliver(delta);
            deliver(frame);
            newest = frame.entryId;
          }
          deltas = [];
        } else if (frame.type === "held" && shown.has(frame.call.number)) {
          // Already sent above with the waiting calls.
        } else {
          deliver(frame);
        }
      }
      for (const delta of deltas) deliver(delta);
      this.framesSent.set(device, framesSent);
      this.handoffs.delete(device);
      if (newest !== undefined) await cell.markDelivered(device, newest);
    } finally {
      if (this.handoffs.get(device) === held) this.handoffs.delete(device);
    }
    logEvent("cli.session", {
      cell: person,
      device,
      phase: "open",
      frames_sent: framesSent,
      missed_delivered: delivered,
    });
    const init: ResponseInit & { webSocket: SocketLike } = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  }

  /** One chat line from a socket: submitted to the lead unchanged, acknowledged by request id. */
  async webSocketMessage(socket: SocketLike, data: string | ArrayBuffer): Promise<void> {
    const { person, device } = this.tagsOf(socket);
    const parsed = parseInput(data);
    if (!parsed.ok) {
      logEvent(
        "input.rejected",
        { cell: person, device, request_id: parsed.requestId ?? null, reason: parsed.reason },
        "warn",
      );
      // A frame keyed by request id tells the client to stop resending that line.
      const frame: Frame =
        parsed.requestId === undefined
          ? { type: "error", message: parsed.reason }
          : { type: "rejected", requestId: parsed.requestId, message: parsed.reason };
      socket.send(JSON.stringify(frame));
      return;
    }
    const { input } = parsed;
    try {
      const cell = await this.cell(person);
      await this.ensureStream(cell);
      const { submissionId } = await this.submitInput(person, input.text, input.requestId);
      logEvent("input.submitted", {
        cell: person,
        device,
        request_id: input.requestId,
        submission_id: submissionId,
        chars: input.text.length,
      });
    } catch (error) {
      logEvent(
        "input.failed",
        { cell: person, device, request_id: input.requestId, ...errorFields(error) },
        "error",
      );
      // Not acknowledged: the client keeps the line and resends it after a reconnect.
      socket.send(
        JSON.stringify({
          type: "error",
          requestId: input.requestId,
          message: "the cell could not take this message now; it is sent again on reconnect",
        } satisfies Frame),
      );
      return;
    }
    socket.send(JSON.stringify({ type: "accepted", requestId: input.requestId } satisfies Frame));
  }

  async webSocketClose(socket: SocketLike, code: number): Promise<void> {
    const { device, person } = this.tagsOf(socket);
    logEvent("cli.session", {
      cell: person,
      device,
      phase: "close",
      code,
      frames_sent: this.framesSent.get(device) ?? 0,
    });
    try {
      socket.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }

  /** RPC for other cells and later inputs (such as mail): submit into the lead, unchanged. */
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
    const household = householdClientOf(this.env);
    if (household === undefined) throw new Error("no household cell: no binding and no URL");
    return household.read(document);
  }

  /** RPC (test-cell lab): this person cell changes a household document as `person`. */
  async householdChange(person: string, change: HouseholdChange): Promise<HouseholdApplyResult> {
    const household = householdClientOf(this.env);
    if (household === undefined) throw new Error("no household cell: no binding and no URL");
    return household.apply({ ...change, fromCell: person });
  }

  /** Closes the harness of this activation; the next event opens it again. */
  private async closeHarness(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    this.streaming = undefined;
    this.alarms = undefined;
    if (opening !== undefined) await (await opening.catch(() => undefined))?.close();
  }

  /** RPC: the whole database as one dump, taken in one transaction. */
  async snapshot(contractStep: number): Promise<CellDump> {
    const dump = await this.snapshots().snapshot(contractStep);
    logEvent("cell.snapshot", {
      cell: this.storedName() ?? null,
      digest: dump.digest,
      rows: dump.rows,
    });
    return dump;
  }

  /**
   * RPC: replaces the database with `dump` and opens the harness on it as `person`, which resumes
   * the restored tasks and sets the alarm from the restored timers.
   */
  async restore(dump: CellDump, person: string): Promise<{ digest: string; rows: number }> {
    if (!PERSON.test(person)) throw new Error(`bad cell name "${person}"`);
    const result = await this.snapshots().restore(dump);
    this.knownName = undefined;
    await this.cell(person);
    logEvent("cell.restored", { cell: person, digest: result.digest, rows: result.rows });
    return result;
  }

  /** RPC: drops every table and the alarm (the test cell after a restore drill). */
  async wipe(): Promise<void> {
    const person = this.storedName() ?? null;
    await this.snapshots().wipe();
    this.knownName = undefined;
    logEvent("cell.wiped", { cell: person });
  }

  /** RPC: the database digest and row count as they are now. */
  async digest(): Promise<{ digest: string; rows: number }> {
    return this.snapshots().digest();
  }

  /** RPC: the heartbeat routine's last run, read by waking the cell (check:heartbeats). */
  async heartbeat(person: string): Promise<HeartbeatState> {
    return heartbeatState((await this.cell(person)).harness);
  }
}
