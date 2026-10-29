// The capacity warning: when more jobs run at once than the cell was measured to handle, the owner
// gets one Better Stack incident in household words (nothing is held back), and the job board
// shows the warning line. The alert skips without a token, like every owner alert.
import { afterEach, describe, expect, it, vi } from "vitest";
import { capacityDescription, capacitySummary, createAlerts } from "../src/alerts.ts";
import { loggedEvents } from "./fixtures.ts";
import { ALERT_ENV, incidentStub } from "./outage-fixtures.ts";

afterEach(() => {
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
