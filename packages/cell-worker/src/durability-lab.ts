/**
 * `DurabilityLabCell`: the test cell's durability lab. Deployed only in the test-cell bundle
 * (wrangler.conformance.jsonc), never to a person cell. It opens the real cell harness on real
 * celld storage and alarms with a scripted model in place of OpenRouter, so the crash, late-alarm,
 * cut-off-call, and household checks run on the test cell with no outside account.
 *
 * The scripted model stands in for the lead's decision, like the unit tests' responders: the
 * lead hands "[lab] hand off" to the research specialist, and in the life that armed it the
 * research call hangs (up to `hangMs`), so a SIGKILL cuts it off. A restarted process was not
 * armed, so the call that runs again answers at once and the turn completes.
 *
 *   POST /lab/arm                  a hand-off mid-call, a reminder 10 minutes ahead, and an open
 *                                  transaction holding a marker row for `holdMs`
 *   GET  /lab/state                what survived: entries, tasks, marker, alarm, wakes, calls, ticks
 *   POST /lab/alarm?set=<ms>|none  induce a wrong or missing alarm (no re-arm)
 *   GET  /lab/alarm-report         the check:alarms verdict for the lab cell (read-only)
 *   POST /lab/household-roundtrip  the owner cell adds an item, the second cell reads it, a retry
 *                                  with the same operation id applies once
 *   POST /lab/load                 the heap load: the lead briefs all four specialists at
 *                                  once on a slow scripted model; one of them is a long job
 *   GET  /lab/load                 how many tasks are live, and the calls so far
 *
 * `writeOne()` (the worker's /ops/write) commits one row in a scratch table: the write-delay probe.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import {
  type AlarmReport,
  alarmVerdict,
  CellAlarm,
  type CellHarness,
  DEFAULT_LEAD_MODEL,
  DEFAULT_SPECIALIST_MODEL,
  defineRoutine,
  type HouseholdApplyResult,
  type HouseholdChange,
  type HouseholdDocument,
  openCellHarness,
  ROUTINE_KIND_PREFIX,
  routineWake,
  STARTER_SPECIALISTS,
  scheduleReminder,
} from "@secbot/cell-harness";
import type { CelldAlarmInfo, CelldCellStorage } from "@secbot/cell-storage";
import { releaseVersion } from "./health.ts";
import { type HouseholdNamespaceLike, householdOf } from "./person-cell.ts";

const LAB = "lab";
export const LAB_ARM_TEXT = "[lab] hand off";
export const LAB_BRIEF = "Lab brief: answer with one line so the lead can relay it.";
export const LAB_LOAD_TEXT = "[lab] load";
const WRITE_PROBE_TABLE =
  "CREATE TABLE IF NOT EXISTS ops_write_probe (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)";
export const LAB_TICK_EVERY_MS = 60_000;
const REMINDER_AHEAD_MS = 10 * 60_000;
const MARKER_TABLE = "CREATE TABLE IF NOT EXISTS lab_marker (id INTEGER PRIMARY KEY, at INTEGER)";
/** The specialist the scripted lead briefs (the research specialist). */
const SPECIALIST = STARTER_SPECIALISTS[2]?.name ?? "";

/** `secbot.lab`: every lab-tick run, written in the same commit as the tick's next wake time. */
export const LabDoc = defineDoc<{ ticks: { wakeAt: number; firedAt: number }[] }>({
  kind: "secbot.lab",
  version: 1,
  scope: "session",
  initial: () => ({ ticks: [] }),
});

interface PersonRpcStub {
  householdRead?(document: string): Promise<HouseholdDocument>;
  householdChange?(person: string, change: HouseholdChange): Promise<HouseholdApplyResult>;
}

export interface LabEnv {
  readonly PERSON_CELL?: { idFromName(name: string): unknown; get(id: unknown): PersonRpcStub };
  readonly HOUSEHOLD_CELL?: HouseholdNamespaceLike;
}

export interface LabState {
  readonly storage: CelldCellStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface LabOptions {
  /** How long the first research call hangs; under the 120 s stream timeout. */
  readonly hangMs?: number;
  /** How long the armed transaction holds its marker row; under celld's 30 s limit. */
  readonly holdMs?: number;
  /** Heap load: how long each specialist call hangs, and the one long job. */
  readonly loadMs?: number;
  readonly longJobMs?: number;
  readonly pollMs?: number;
}

const lastText = (context: TranscriptContext): { role: string; text: string; system: string } => {
  const messages = context.messages as readonly Message[];
  const last = messages.findLast((message) => (message.role as string) !== "system");
  const content = last?.content;
  const text =
    typeof content === "string"
      ? content
      : ((content ?? []) as readonly { type: string; text?: string }[])
          .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
          .join("");
  const system = [
    (context as { systemPrompt?: string }).systemPrompt ?? "",
    ...messages
      .filter((message) => (message.role as string) === "system")
      .flatMap((message) =>
        Object.values((message as { sections?: Record<string, string | null> }).sections ?? {}),
      )
      .map((section) => section ?? ""),
  ].join("\n");
  return { role: last?.role ?? "none", text, system };
};

export class DurabilityLabCell {
  private opening: Promise<CellHarness> | undefined;
  private readonly alarms: CellAlarm;
  /** Model calls in this process's life, by role; a restart starts at zero. */
  readonly calls = { lead: 0, specialist: 0 };
  private readonly startedAt = Date.now();
  private hangs = new Set<() => void>();
  /** Set by /lab/arm in this life only: a restarted process never hangs a call. */
  private armedHere = false;
  /** Set by /lab/load: specialist calls hang until then (the first one until `longUntil`). */
  private load: { until: number; longUntil: number; calls: number } | undefined;

  constructor(
    private readonly state: LabState,
    private readonly env: LabEnv,
    private readonly options: LabOptions = {},
  ) {
    this.alarms = new CellAlarm(state.storage, LAB, {
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    });
  }

  private models() {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [DEFAULT_LEAD_MODEL, DEFAULT_SPECIALIST_MODEL].map((id) => ({ id })),
    });
    faux.setResponses(
      Array.from(
        { length: 10_000 },
        (): FauxResponseFactory => async (request, options) => {
          const { role, text, system } = lastText(request);
          if (system.includes("You are the lead agent")) {
            this.calls.lead++;
            if (role === "toolResult") return fauxAssistantMessage([fauxText("OK.")]);
            if (text.startsWith(LAB_LOAD_TEXT)) {
              return fauxAssistantMessage(
                STARTER_SPECIALISTS.map(({ name }) =>
                  fauxToolCall("handoff", { specialist: name, brief: LAB_BRIEF }),
                ),
                { stopReason: "toolUse" },
              );
            }
            if (text.startsWith(LAB_ARM_TEXT)) {
              return fauxAssistantMessage(
                [fauxToolCall("handoff", { specialist: SPECIALIST, brief: LAB_BRIEF })],
                { stopReason: "toolUse" },
              );
            }
            return fauxAssistantMessage([fauxText(`lab lead relays: ${text.slice(0, 80)}`)]);
          }
          this.calls.specialist++;
          const load = this.load;
          if (load !== undefined && Date.now() < load.until) {
            load.calls++;
            await this.hang(
              (load.calls === 1 ? load.longUntil : load.until) - Date.now(),
              options?.signal,
            );
          } else if (this.armedHere && this.calls.specialist === 1) {
            // The cut-off call: hangs in this life until the hang ends or the call is cancelled.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, this.options.hangMs ?? 100_000);
              const done = () => {
                clearTimeout(timer);
                this.hangs.delete(done);
                resolve();
              };
              this.hangs.add(done);
              options?.signal?.addEventListener("abort", done, { once: true });
            });
          }
          return fauxAssistantMessage([fauxText("lab specialist answer")]);
        },
      ),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  private cell(): Promise<CellHarness> {
    if (this.opening === undefined) {
      const hooks = { cell: LAB, onWakeChange: () => this.rearmSoon() };
      const tick = defineRoutine(
        {
          name: "lab-tick",
          every: LAB_TICK_EVERY_MS,
          run: async (fire) => ({
            outcome: "ok",
            record: async (tx) => {
              const doc = await tx.doc(LabDoc);
              doc.ticks.push({ wakeAt: fire.wakeAt, firedAt: fire.runtime.now() });
              doc.ticks.splice(0, Math.max(0, doc.ticks.length - 50));
            },
          }),
        },
        hooks,
      );
      this.opening = openCellHarness(this.state.storage, {
        person: LAB,
        version: releaseVersion(),
        env: {},
        models: this.models(),
        onWakeChange: hooks.onWakeChange,
        routines: [{ routine: tick }],
      }).then(async (cell) => {
        await this.alarms.rearm(cell);
        const settled = this.alarms.settle(cell).catch(() => {});
        this.state.waitUntil?.(settled);
        return cell;
      });
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private rearmSoon(): void {
    const opening = this.opening;
    if (opening === undefined) return;
    const work = opening.then((cell) => this.alarms.rearm(cell)).catch(() => {});
    this.state.waitUntil?.(work);
  }

  /** Waits `ms`, ended early by `releaseHangs()` or the call's abort signal. */
  private hang(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        resolve();
      }
      const release = () => {
        this.hangs.delete(release);
        done();
      };
      this.hangs.add(release);
      signal?.addEventListener("abort", release, { once: true });
    });
  }

  /** POST /lab/load: the lead briefs every specialist at once; one brief is a long job. */
  async startLoad(): Promise<Record<string, unknown>> {
    const cell = await this.cell();
    const startedAt = Date.now();
    this.load = {
      until: startedAt + (this.options.loadMs ?? 60_000),
      longUntil: startedAt + (this.options.longJobMs ?? 120_000),
      calls: 0,
    };
    await cell.submit(LAB_LOAD_TEXT, `lab-load:${startedAt}`);
    return { started: true, startedAt, until: this.load.until, longUntil: this.load.longUntil };
  }

  /** GET /lab/load: live tasks now, and the load's specialist calls so far. */
  async loadState(): Promise<Record<string, unknown>> {
    const cell = await this.cell();
    const inspection = await cell.harness.inspect(context);
    const live = inspection.tasks.filter(({ record }) =>
      ["pending", "running", "waiting"].includes(record.state.status),
    ).length;
    return {
      live,
      specialistCalls: this.load?.calls ?? 0,
      loading: this.load !== undefined && Date.now() < this.load.longUntil,
    };
  }

  /** RPC (/ops/write): one committed single-row write; keeps the last 100 rows. */
  async writeOne(): Promise<void> {
    const cell = await this.cell();
    await cell.database.transaction(async (tx) => {
      await tx.exec(WRITE_PROBE_TABLE);
      await tx.run("INSERT INTO ops_write_probe (at) VALUES (?)", Date.now());
      await tx.run(
        "DELETE FROM ops_write_probe WHERE id <= (SELECT max(id) - 100 FROM ops_write_probe)",
      );
    });
  }

  /** Ends a hanging call at once (tests). */
  releaseHangs(): void {
    for (const done of [...this.hangs]) done();
  }

  async alarm(info?: CelldAlarmInfo): Promise<void> {
    this.alarms.fired(info, undefined);
    await this.alarms.settle(await this.cell());
  }

  /** RPC and GET /lab/alarm-report: read-only. */
  async alarmReport(): Promise<AlarmReport> {
    const alarm = await this.state.storage.getAlarm();
    const { summary } = await (await this.cell()).wakes();
    return alarmVerdict(LAB, alarm, summary);
  }

  async arm(): Promise<Record<string, unknown>> {
    const cell = await this.cell();
    this.armedHere = true;
    const armedAt = Date.now();
    await cell.submit(LAB_ARM_TEXT, `lab-arm:${armedAt}`);
    const deadline = Date.now() + 20_000;
    while (this.calls.specialist === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const reminderAt = armedAt + REMINDER_AHEAD_MS;
    const reminderTaskId = await scheduleReminder(
      cell.harness,
      cell.reminders,
      `lab:${armedAt}`,
      reminderAt,
      "lab reminder",
      context,
    );
    await this.alarms.rearm(cell);
    const holdMs = this.options.holdMs ?? 20_000;
    const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
    const hold = cell.database
      .transaction(async (tx) => {
        await tx.exec(MARKER_TABLE);
        await tx.run("INSERT INTO lab_marker (at) VALUES (?)", armedAt);
        markOpened();
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      })
      .catch(() => markOpened());
    this.state.waitUntil?.(hold);
    await opened;
    return {
      armed: true,
      armedAt,
      specialistCallStarted: this.calls.specialist > 0,
      reminderTaskId: String(reminderTaskId),
      reminderAt,
      holdMs,
    };
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const cell = await this.cell();
    const alarm = await this.state.storage.getAlarm();
    const { summary, next } = await cell.wakes();
    const inspection = await cell.harness.inspect(context);
    const entries = await cell.root.entries({}, 500, undefined, context);
    const texts = entries.items.flatMap((entry) => {
      const message = entry.model?.[0] as Message | undefined;
      if (message === undefined || (message.role !== "user" && message.role !== "assistant")) {
        return [];
      }
      const content = message.content;
      return [
        typeof content === "string"
          ? content
          : (content as readonly { type: string; text?: string }[])
              .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
              .join(""),
      ];
    });
    await cell.database.exec(MARKER_TABLE);
    const marker = await cell.database.get<{ n: number }>("SELECT count(*) AS n FROM lab_marker");
    const lab = await cell.harness.snapshot(LabDoc, context);
    return {
      startedAt: this.startedAt,
      calls: this.calls,
      leadEntries: entries.items.length,
      armed: texts.some((text) => text.startsWith(LAB_ARM_TEXT)),
      followupReported: texts.some((text) => text.startsWith(`[handoff ${SPECIALIST} answered]`)),
      markerRows: Number(marker?.n ?? 0),
      alarm,
      next: next ?? null,
      earliest: summary.wakes[0] ?? null,
      liveUntimed: summary.liveUntimed,
      tasks: inspection.tasks.map(({ record, state }) => ({
        id: String(record.id),
        kind: record.kind,
        state: state.kind,
        ...(record.kind.startsWith(ROUTINE_KIND_PREFIX) &&
        record.state.status !== "terminal" &&
        record.state.status !== "completing"
          ? { wakeAt: routineWake(record.state.checkpoint) ?? null }
          : {}),
      })),
      ticks: lab?.ticks ?? [],
    };
  }

  async householdRoundTrip(): Promise<Record<string, unknown>> {
    const persons = this.env.PERSON_CELL;
    if (persons === undefined || householdOf(this.env) === undefined) {
      return { ok: false, reason: "the test cell has no PERSON_CELL or HOUSEHOLD_CELL binding" };
    }
    const owner = persons.get(persons.idFromName("owner"));
    const second = persons.get(persons.idFromName("second"));
    if (owner.householdChange === undefined || second.householdRead === undefined) {
      return { ok: false, reason: "the person cells do not answer RPC" };
    }
    const opId = `lab:${Date.now()}`;
    const change: HouseholdChange = {
      opId,
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: `lab item ${opId}`,
    };
    const added = await owner.householdChange("owner", change);
    const retried = await owner.householdChange("owner", change);
    const read = await second.householdRead("list");
    const copies = read.items.filter((item) => item.itemId === opId).length;
    return {
      ok: added.outcome === "applied" && retried.duplicate && copies === 1,
      opId,
      added,
      retried,
      seenBySecond: copies > 0,
      copies,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /lab/arm") return Response.json(await this.arm());
    if (route === "GET /lab/state") return Response.json(await this.snapshot());
    if (route === "GET /lab/alarm-report") return Response.json(await this.alarmReport());
    if (route === "POST /lab/household-roundtrip") {
      return Response.json(await this.householdRoundTrip());
    }
    if (route === "POST /lab/load") return Response.json(await this.startLoad());
    if (route === "GET /lab/load") return Response.json(await this.loadState());
    if (route === "POST /lab/alarm") {
      await this.cell();
      const set = url.searchParams.get("set") ?? "";
      if (set === "none") await this.state.storage.deleteAlarm();
      else if (/^\d{13}$/.test(set)) await this.state.storage.setAlarm(Number(set));
      else return Response.json({ error: "set=<epoch ms>|none" }, { status: 400 });
      return Response.json({ alarm: await this.state.storage.getAlarm() });
    }
    if (route === "POST /lab/rearm") {
      await this.alarms.rearm(await this.cell());
      return Response.json({ alarm: await this.state.storage.getAlarm() });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Tests: closes the harness. */
  async close(): Promise<void> {
    this.releaseHangs();
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) await (await opening).close();
  }
}
