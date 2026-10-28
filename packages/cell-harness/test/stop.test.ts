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
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { createHold, type Hold, jobResponder, startJobLine } from "./responders.ts";

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
});
