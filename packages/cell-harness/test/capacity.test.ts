// The capacity warning: when more jobs run at once than the cell was measured to handle, the owner
// gets one Better Stack incident in household words (nothing is held back), and the job board
// shows the warning line. The alert skips without a token, like every owner alert.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capacityDescription, capacitySummary, createAlerts } from "../src/alerts.ts";
import { effectiveCapacity } from "../src/capacity-watch.ts";
import { CapacityDoc } from "../src/docs.ts";
import { CAPACITY_REARM_MS } from "../src/release-defaults.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { ALERT_ENV, incidentStub } from "./outage-fixtures.ts";
import { jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const alertLines = (calls: readonly unknown[][]) =>
  loggedEvents(calls).filter((line) => line.event === "model.alert");

describe("the capacity alert", () => {
  it("sends one incident with the counts and says nothing is held back", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = incidentStub();
    const alerts = createAlerts(ALERT_ENV, "owner", stub.fetcher);
    expect(await alerts.sendCapacity(3, 2)).toBe(true);
    expect(stub.incidents).toHaveLength(1);
    expect(stub.incidents[0]?.body).toMatchObject({
      summary: "Secbot owner cell: 3 jobs at once, measured at 2",
      name: "Secbot owner cell: 3 jobs at once, measured at 2",
      description:
        "More jobs are running at once than this cell was measured to handle. Nothing is held back; a cell that runs out of memory restarts and its jobs resume. See secbot jobs.",
      requester_email: ALERT_ENV.BETTERSTACK_REQUESTER_EMAIL,
    });
    expect(capacitySummary("owner", 3, 2)).toBe(stub.incidents[0]?.body.summary);
    expect(capacityDescription()).toBe(stub.incidents[0]?.body.description);
    expect(alertLines(log.mock.calls)).toEqual([
      expect.objectContaining({
        cell: "owner",
        kind: "capacity",
        parallel_jobs: 3,
        measured: 2,
        outcome: "sent",
        http_status: 201,
      }),
    ]);
  });

  it("skips without a token and logs the skip", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = incidentStub();
    const alerts = createAlerts({}, "owner", stub.fetcher);
    expect(await alerts.sendCapacity(5, 4)).toBe(true);
    expect(stub.incidents).toEqual([]);
    expect(alertLines(log.mock.calls)).toEqual([
      expect.objectContaining({
        kind: "capacity",
        parallel_jobs: 5,
        measured: 4,
        outcome: "skipped",
      }),
    ]);
  });
});

describe("the effective number", () => {
  it("prefers the cell's setting, then the release default at midnight UTC of its day", () => {
    expect(effectiveCapacity({ measured: 3, at: 7 }, { jobs: 8, on: "2026-10-30" })).toEqual({
      measured: 3,
      at: 7,
    });
    expect(effectiveCapacity({ measured: null, at: null }, { jobs: 8, on: "2026-10-30" })).toEqual({
      measured: 8,
      at: Date.UTC(2026, 9, 30),
    });
    expect(effectiveCapacity(undefined, null)).toBeNull();
    expect(effectiveCapacity({ measured: null, at: null }, null)).toBeNull();
  });
});

/** Research jobs that call the slow fixture tool and answer after it (jobs stay running). */
const slowJobs: Responder = (request) => {
  if (request.role !== "research") return jobResponder(request);
  return request.last?.role === "toolResult"
    ? fauxAssistantMessage([fauxText("three options")])
    : fauxAssistantMessage([fauxToolCall("fixture_slow_lookup", { topic: "flights" })], {
        stopReason: "toolUse",
      });
};

/** Research jobs that wait for `release(n)`, with `n` from the `gate-<n>` word of their brief. */
function gatedJobs() {
  const gates = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();
  const gateOf = (n: string) => {
    if (!waits.has(n)) {
      waits.set(
        n,
        new Promise<void>((resolve) => {
          gates.set(n, resolve);
        }),
      );
    }
    return waits.get(n) as Promise<void>;
  };
  const respond: Responder = async (request) => {
    if (request.role !== "research") return jobResponder(request);
    const n = /gate-(\d+)/.exec(request.lastText)?.[1];
    if (n !== undefined) await gateOf(n);
    return fauxAssistantMessage([fauxText("done")]);
  };
  return {
    respond,
    release: (n: number) => {
      gateOf(String(n));
      gates.get(String(n))?.();
    },
  };
}

const startJobs = async (t: TestCell, from: number, count: number) => {
  const lines = Array.from({ length: count }, (_, i) =>
    startJobLine({
      title: `job ${from + i}`,
      brief: `look it up (gate-${from + i})`,
      template: "research",
    }),
  ).join("\n");
  await (await t.cell.submit(lines, `start-${from}`)).wait(BACKGROUND_CONTEXT);
};

const running = async (t: TestCell) =>
  Object.values((await t.cell.board()).jobs).filter((row) => row.status === "running").length;

const setMeasured = async (t: TestCell, measured: number | null, at: number | null) =>
  t.cell.harness.commit(async (tx) => {
    Object.assign(await tx.doc(CapacityDoc), { measured, at });
  }, BACKGROUND_CONTEXT);

const passing = async (t: TestCell) =>
  (await t.cell.harness.snapshot(CapacityDoc, BACKGROUND_CONTEXT))?.passing;

const passedLines = (calls: readonly unknown[][]) =>
  loggedEvents(calls).filter((line) => line.event === "capacity.passed");

describe("the capacity watch on a cell", () => {
  it("alerts once when three jobs pass a measured 2, shows the line, and holds no job back", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = incidentStub();
    test = await openTestCell({
      env: ALERT_ENV,
      fetch: stub.fetcher,
      fixtureTools: { slowMs: 60_000 },
      gateway: createFauxGateway(slowJobs),
    });
    const t = test;
    await setMeasured(t, 2, Date.UTC(2026, 9, 29));
    await startJobs(t, 1, 3);
    await until(async () => (await running(t)) === 3);
    await until(() => stub.incidents.length > 0);
    expect(stub.incidents).toHaveLength(1);
    expect(stub.incidents[0]?.body.summary).toBe(
      "Secbot owner cell: 3 jobs at once, measured at 2",
    );
    expect(passedLines(log.mock.calls)).toEqual([
      expect.objectContaining({ cell: "owner", parallel_jobs: 3, measured: 2 }),
    ]);
    const view = await t.cell.jobsView();
    expect(view.capacity).toMatchObject({ jobsAtOnce: 3, measured: 2 });
    expect(view.rows.map((row) => row.status)).toEqual(["running", "running", "running"]);
    // A fourth job in the same episode sends nothing more.
    await startJobs(t, 4, 1);
    await until(async () => (await running(t)) === 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.incidents).toHaveLength(1);
    expect((await t.cell.jobsView()).capacity).toMatchObject({ jobsAtOnce: 4, measured: 2 });
  });

  it("re-arms only a day after the last alert when the count falls back and rises again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = incidentStub();
    let offset = 0;
    const jobs = gatedJobs();
    test = await openTestCell({
      env: ALERT_ENV,
      fetch: stub.fetcher,
      now: () => Date.now() + offset,
      gateway: createFauxGateway(jobs.respond),
    });
    const t = test;
    await setMeasured(t, 2, Date.UTC(2026, 9, 29));
    await startJobs(t, 1, 3);
    await until(() => stub.incidents.length === 1);
    // Falls to 2: the episode closes.
    jobs.release(1);
    await until(async () => (await passing(t)) === false);
    // Rises to 3 within the day: no alert.
    await startJobs(t, 4, 1);
    await until(async () => (await passing(t)) === true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.incidents).toHaveLength(1);
    // Falls again, and rises after a day: one more alert.
    jobs.release(2);
    await until(async () => (await passing(t)) === false);
    offset = CAPACITY_REARM_MS + 60_000;
    await startJobs(t, 5, 1);
    await until(() => stub.incidents.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.incidents).toHaveLength(2);
    for (const n of [3, 4, 5]) jobs.release(n);
  });

  it("shows no line and sends no alert with no measured number", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = incidentStub();
    test = await openTestCell({
      env: ALERT_ENV,
      fetch: stub.fetcher,
      fixtureTools: { slowMs: 60_000 },
      gateway: createFauxGateway(slowJobs),
    });
    const t = test;
    await startJobs(t, 1, 3);
    await until(async () => (await running(t)) === 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.incidents).toEqual([]);
    expect(passedLines(log.mock.calls)).toEqual([]);
    expect((await t.cell.jobsView()).capacity).toBeNull();
  });
});
