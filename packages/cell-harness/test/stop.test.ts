// The stop: every unfinished job with a live task and the lead's current turn stop within one
// step; a finished job's wake, routines, and reminders keep their schedule; no job starts while
// the stop runs (AC-29, harness half).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopDoc } from "../src/docs.ts";
import { defineRoutine } from "../src/routines.ts";
import { STOP_RUNNING, stopJobs } from "../src/stop.ts";
import {
  createFauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { createHold, type Hold, jobResponder, startJobLine } from "./responders.ts";
import { answerFrom, openPair, proposeFrom } from "./shared-pair.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

/** Research answers (held by the test), household fails the same way, health asks the lead. */
const stopResponder = (request: FauxRequest) => {
  if (request.role === "household") {
    return fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
      stopReason: "toolUse",
    });
  }
  if (request.role === "health" && request.last?.role !== "toolResult") {
    return fauxAssistantMessage([fauxToolCall("ask_lead", { question: "Which week?" })], {
      stopReason: "toolUse",
    });
  }
  return jobResponder(request);
};

const tick = defineRoutine(
  { name: "tick", every: 60 * 60_000, run: async () => ({ outcome: "ok" }) },
  { cell: "owner" },
);

let lines = 0;
const lead = async (t: TestCell, text: string) =>
  (await t.cell.submit(text, `stop-${++lines}`)).wait(BACKGROUND_CONTEXT);
const job = async (t: TestCell, n: number) => (await t.cell.board()).jobs[String(n)];
const start = (title: string, template: string) =>
  startJobLine({ title, brief: `${title}, please.`, template });

/** The routine and reminder wake times, by source. */
const timers = async (t: TestCell) =>
  Object.fromEntries(
    (await t.cell.wakes()).summary.wakes
      .filter((wake) => wake.source === "tick" || wake.source === "reminder")
      .map((wake) => [wake.source, wake.at]),
  );

async function busyCell(hold: Hold): Promise<TestCell> {
  test = await openTestCell({
    gateway: createFauxGateway(hold.wrap(stopResponder)),
    routines: [{ routine: tick, firstWakeMs: 60 * 60_000 }],
  });
  const t = test;
  await lead(t, start("passport week", "health"));
  await until(async () => (await job(t, 1))?.status === "waiting");
  await lead(t, start("shopping list", "household"));
  await until(async () => (await job(t, 2))?.status === "paused");
  await lead(t, start("bin day", "developer"));
  await until(async () => (await job(t, 3))?.status === "done");
  hold.hold("research");
  await lead(t, start("flights to Lisbon", "research"));
  await lead(t, start("train times", "research"));
  await until(() => hold.waiting("research") === 2);
  const at = new Date(Date.now() + 60 * 60_000).toISOString();
  await lead(t, `CALL set_reminder ${JSON.stringify({ at, text: "check the oven" })}`);
  hold.hold("lead");
  void t.cell.submit("what is the weather like?", "busy");
  await until(() => hold.waiting("lead") === 1);
  return t;
}

describe("the stop", () => {
  it("stops every unfinished job and the lead's turn, and keeps the rest running", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    const t = await busyCell(hold);
    const before = await timers(t);
    expect(Object.keys(before).sort()).toEqual(["reminder", "tick"]);
    const doneTask = (await job(t, 3))?.taskId;
    const requests = t.gateway.requests.length;

    const stopping = stopJobs(
      { harness: t.cell.harness, root: t.cell.root, person: "owner", now: Date.now },
      "person",
      BACKGROUND_CONTEXT,
    );
    // The faux model answers a held step only when released; the abort lands at that step.
    await until(
      async () => (await t.cell.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
    );
    hold.release("research");
    hold.release("lead");
    const answer = await stopping;
    expect(answer).toEqual({ jobs: 4, turn: true });
    for (const n of [1, 2, 4, 5]) {
      expect(await job(t, n)).toMatchObject({ status: "stopped", stop: { by: "person" } });
    }
    expect(await job(t, 3)).toMatchObject({ status: "done", stop: null });

    await new Promise((resolve) => setTimeout(resolve, 50));
    // No job asks the model again, and the lead's run has ended.
    const after = t.gateway.requests.slice(requests).filter((request) => request.role !== "lead");
    expect(after).toEqual([]);
    expect(
      (await t.cell.harness.snapshot(LiveDoc, t.cell.root.id, BACKGROUND_CONTEXT))?.run,
    ).toBeUndefined();
    const live = await t.cell.harness.inspect(BACKGROUND_CONTEXT);
    const doneLive = live.tasks.find(({ record }) => String(record.id) === String(doneTask));
    expect(doneLive?.record.state.status).not.toBe("terminal");
    expect(await timers(t)).toEqual(before);
    expect(await t.cell.harness.snapshot(StopDoc, BACKGROUND_CONTEXT)).toMatchObject({
      active: null,
      last: { by: "person", jobs: 4, turn: true },
    });
    const events = loggedEvents(log.mock.calls);
    expect(events.filter((line) => line.event === "job.stopped").map((line) => line.job)).toEqual([
      1, 2, 4, 5,
    ]);
    expect(events.find((line) => line.event === "stop.done")).toMatchObject({
      cell: "owner",
      by: "person",
      jobs: 4,
      turn: true,
    });
    expect(events.some((line) => line.event === "stop.left_running")).toBe(false);
  }, 30_000);

  it("stops nothing on an idle cell and records it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const t = test;
    const answer = await stopJobs(
      { harness: t.cell.harness, root: t.cell.root, person: "owner", now: () => 5_000 },
      "owner",
      BACKGROUND_CONTEXT,
    );
    expect(answer).toEqual({ jobs: 0, turn: false });
    expect(await t.cell.harness.snapshot(StopDoc, BACKGROUND_CONTEXT)).toEqual({
      active: null,
      last: { at: 5_000, by: "owner", jobs: 0, turn: false },
    });
  });
  it("lifts the lock when an abort throws, and a lock left by a dead stop is lifted on open", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    hold.hold("research");
    await lead(t, start("flights", "research"));
    await until(() => hold.waiting("research") === 1);
    const abort = vi.spyOn(t.cell.harness, "abortTask").mockRejectedValueOnce(new Error("gone"));
    await stopJobs(
      { harness: t.cell.harness, root: t.cell.root, person: "owner", now: () => 7_000 },
      "person",
      BACKGROUND_CONTEXT,
    );
    abort.mockRestore();
    expect((await t.cell.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active).toBeNull();
    hold.release("research");
    // A stop that died between its two commits leaves the lock set; the next open lifts it.
    await t.cell.harness.commit(async (tx) => {
      (await tx.doc(StopDoc)).active = { at: 8_000, by: "person" };
    }, BACKGROUND_CONTEXT);
    const reopened = await t.reopen();
    expect((await reopened.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active).toBeNull();
  });
  it("starts no job while the stop runs", { timeout: 20_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    hold.hold("research");
    await lead(t, start("flights", "research"));
    await until(() => hold.waiting("research") === 1);
    let refused = "";
    const answer = await stopJobs(
      { harness: t.cell.harness, root: t.cell.root, person: "owner", now: Date.now },
      "person",
      BACKGROUND_CONTEXT,
      {
        afterLock: async () => {
          await lead(t, start("train times", "research"));
          refused = (await toolResultsOf(t.cell.root)).at(-1) ?? "";
          // Released once the abort is marked: the held step then ends aborted.
          setTimeout(() => hold.release("research"), 200);
        },
      },
    );
    expect(answer.jobs).toBe(1);
    expect(refused).toBe(STOP_RUNNING);
    const board = await t.cell.board();
    expect(Object.keys(board.jobs)).toEqual(["1"]);
    const jobs = (await t.cell.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === "secbot.job" && record.state.status !== "terminal",
    );
    expect(jobs).toEqual([]);
  });
});

describe("the cell's stop, board view, and reorder", () => {
  it("stops through the cell and shows the stopped row with its reason", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({
      gateway: createFauxGateway(hold.wrap(jobResponder)),
      env: { SECBOT_TIME_ZONE: "UTC" },
    });
    const t = test;
    hold.hold("research");
    await lead(t, start("flights to Lisbon", "research"));
    await until(() => hold.waiting("research") === 1);
    const before = await t.cell.jobsView();
    expect(before).toMatchObject({ person: "owner", mode: "shadow", live: 1, waiting: 0 });
    expect(before.rows[0]).toMatchObject({ number: 1, status: "running", reason: null });
    const stopping = t.cell.stop();
    await until(async () => (await job(t, 1))?.stop != null);
    hold.release("research");
    expect(await stopping).toEqual({ jobs: 1, turn: false });
    const view = await t.cell.jobsView();
    expect(view.rows).toEqual([]);
    const stopped = view.finished[0];
    expect(stopped).toMatchObject({ number: 1, status: "stopped", title: "flights to Lisbon" });
    expect(stopped?.reason?.text).toMatch(/^stopped by you at \d\d:\d\d; secbot jobs restart 1$/);
  });

  it("reorders through the cell and refuses a missing or ended job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    hold.hold("research");
    for (const title of ["one", "two", "three", "four"]) await lead(t, start(title, "research"));
    expect(await t.cell.reorderJob(4, { urgent: true })).toEqual({
      ok: true,
      job: 4,
      title: "four",
      priority: "urgent",
      deadline: null,
      place: 1,
      of: 4,
    });
    expect(await t.cell.reorderJob(4, { deadline: "2026-10-12" })).toMatchObject({
      priority: "deadline",
      deadline: "2026-10-12",
      place: 1,
    });
    expect(await t.cell.reorderJob(4, { deadline: null })).toMatchObject({
      priority: "routine",
      place: 4,
    });
    expect(await t.cell.reorderJob(4, { before: 2 })).toMatchObject({ place: 2, before: 2 });
    expect(await t.cell.reorderJob(22, { urgent: true })).toEqual({
      ok: false,
      reason: "no-job",
      job: 22,
    });
    const stopping = t.cell.stop();
    await until(async () => (await job(t, 1))?.stop != null);
    hold.release("research");
    await stopping;
    expect(await t.cell.reorderJob(1, { urgent: true })).toEqual({
      ok: false,
      reason: "ended",
      job: 1,
    });
    expect((await t.cell.jobsView()).rows).toEqual([]);
  });
});

describe("the person's stop of shared jobs", () => {
  it("stops a joined shared job in the household with the person's own job, and leaves an unjoined offer waiting", async () => {
    const hold = createHold();
    hold.hold("household");
    hold.hold("unknown");
    hold.hold("research");
    const pair = await openPair(hold.wrap(() => fauxAssistantMessage([fauxText("Plan.")])));
    await proposeFrom(pair);
    await pair.sync("owner");
    await pair.sync("second");
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    await until(() => hold.waiting("household") + hold.waiting("unknown") === 1);
    await pair.sync("owner");
    expect((await pair.row("owner", 1))?.shared?.consent).toBe("joined");
    await (
      await pair.owner.cell.submit(
        startJobLine({ title: "flights", brief: "find flights", template: "research" }),
        "own",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(() => hold.waiting("research") === 1);
    await proposeFrom(pair, "the garden");
    await pair.sync("owner");
    await pair.sync("second");

    const stopping = pair.owner.cell.stop("person");
    await until(
      async () =>
        (await pair.owner.cell.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null ||
        (await pair.row("owner", 2))?.status === "stopped",
    );
    hold.release("research");
    // The household's stop aborts its job at the held step, once the stop op has reached it.
    await until(() =>
      pair.requests.some((request) => request.ops.some((op) => op.kind === "stop")),
    );
    hold.release("household");
    hold.release("unknown");
    const answer = await stopping;
    expect(answer.jobs).toBe(2);
    expect(pair.requests.flatMap((request) => request.ops).map((op) => op.kind)).toContain("stop");
    expect(await pair.row("owner", 2)).toMatchObject({ status: "stopped" });
    expect(await pair.row("owner", 1)).toMatchObject({ status: "stopped" });
    expect((await pair.row("owner", 1))?.shared?.outbox).toEqual([]);
    expect(await pair.row("owner", 3)).toMatchObject({ status: "waiting" });
    expect((await pair.row("second", 2))?.shared?.consent).toBe("offered");
  });
});
