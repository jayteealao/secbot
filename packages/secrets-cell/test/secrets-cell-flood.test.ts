// The secrets cell when celld gives it back and closes its database while its heartbeat routine
// still runs (a version swap or an idle eviction): the cell logs one report and one reopen line,
// its routine stops instead of pinging and reporting without end, and once celld takes the cell
// in again the next request opens a new harness on the same storage.
import { onLogEvent } from "@secbot/cell-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { testCustody } from "../src/key-custody.ts";
import { SecretsCell } from "../src/secrets-cell.ts";

const VALUE = "test-secret-value-1234"; // gitleaks:allow (fake test value)

const cells: SecretsCell[] = [];
afterEach(async () => {
  for (const cell of cells.splice(0)) await cell.close();
  vi.restoreAllMocks();
});

describe("the secrets cell on a gone database", () => {
  it("logs one report and one reopen, stops its heartbeat loop, and answers from a new harness", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const custody = testCustody();
    let clock = Date.now();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const make = () =>
      new SecretsCell(
        { storage },
        { SECBOT_HEARTBEAT_URLS: "secrets:https://heartbeat.example.test/secrets" },
        {
          custody,
          now: () => clock,
          pollMs: 5,
          // The second cell's first ping waits until the test has given the database away.
          fetch: async () => {
            if (held) await released;
            return new Response("ok");
          },
        },
      );
    const first = make();
    await first.add({ person: "owner", name: "test-secret", value: VALUE });
    await first.allowlist({
      person: "owner",
      secret: "test-secret",
      agent: "research",
      action: "add",
    });
    await first.grant({ person: "owner", secret: "test-secret", agent: "research" });
    const due = await storage.getAlarm();
    await first.close();
    if (due === null) throw new Error("no alarm after open");

    // The heartbeat is overdue when the second cell opens, so it runs at once.
    clock = due + 1_000;
    held = true;
    const second = make();
    cells.push(second);
    const events: string[] = [];
    const count = (name: string) => events.filter((event) => event === name).length;
    const stop = onLogEvent((event) => {
      events.push(event);
      // A guard for the failing case: without the fix the routine pings and reports without end
      // and starves the timers, so the database comes back after 200 pings to end the loop.
      if (count("heartbeat.ping") === 200) storage.gaveBack = undefined;
    });
    try {
      expect(await second.status()).toMatchObject({ status: "up" });
      // celld gives the cell back while the ping is in flight: the routine's commit fails.
      storage.gaveBack = "SecretsCell:test";
      release();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(count("harness.report")).toBeLessThanOrEqual(1);
      expect(count("cell.reopen")).toBe(1);
      expect(count("heartbeat.ping")).toBeLessThanOrEqual(2);
      expect(count("harness.reports_suppressed")).toBeLessThanOrEqual(1);
      const pings = count("heartbeat.ping");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(count("heartbeat.ping")).toBe(pings);

      // celld takes the cell in again: the next request opens a new harness and answers.
      storage.gaveBack = undefined;
      const started = count("secrets.started");
      expect(await second.get({ person: "owner", agent: "research", name: "test-secret" })).toEqual(
        { ok: true, value: { value: VALUE } },
      );
      expect(count("secrets.started")).toBe(started + 1);
      expect(count("cell.reopen")).toBe(1);
    } finally {
      stop();
    }
  }, 60_000);

  it("refuses to start without a usable key, and logs no open failure for it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = testCustody();
    let usable = false;
    const cell = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      {
        custody: {
          ...healthy,
          health: async () =>
            usable ? healthy.health() : { ok: false, reason: "key file missing" },
        },
      },
    );
    cells.push(cell);
    expect(await cell.list({ person: "owner" })).toEqual({
      ok: false,
      status: 503,
      error: "secrets cell unavailable",
    });
    const lines = error.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string });
    expect(lines.map((line) => line.event)).not.toContain("cell.open_failed");
    // The refusal does not stick: the next request tries again and opens.
    usable = true;
    expect(await cell.list({ person: "owner" })).toEqual({ ok: true, value: [] });
  });
});
