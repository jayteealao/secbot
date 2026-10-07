// The heartbeat routine's ping: once per wake to the cell's own URL from the runtime var, skipped
// without one, a failure logged, and the URL never in a log line. Its stored state: the last 2xx
// ping time moves only on a 2xx, and no URL is stored.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_EVERY_MS,
  heartbeatState,
  heartbeatUrl,
  pingRoutineHeartbeat,
} from "../src/heartbeat.ts";
import { FakeCelldStorage, loggedEvents, openTestCell, type TestCell, until } from "./fixtures.ts";

const URLS =
  "owner:https://heartbeat.example.test/owner-cell,household:https://heartbeat.example.test/household-cell,owner.briefing:https://heartbeat.example.test/briefing,second:http://plain.example.test/x";

const opened: TestCell[] = [];
afterEach(async () => {
  for (const test of opened.splice(0)) await test.cell.close().catch(() => {});
  vi.restoreAllMocks();
});

describe("heartbeat", () => {
  it("finds each cell's URL and a routine's own key, and only https URLs", () => {
    const env = { SECBOT_HEARTBEAT_URLS: URLS };
    expect(heartbeatUrl(env, "owner")).toBe("https://heartbeat.example.test/owner-cell");
    expect(heartbeatUrl(env, "household")).toBe("https://heartbeat.example.test/household-cell");
    expect(heartbeatUrl(env, "owner.briefing")).toBe("https://heartbeat.example.test/briefing");
    expect(heartbeatUrl(env, "second")).toBeUndefined();
    expect(heartbeatUrl({}, "owner")).toBeUndefined();
  });

  it("pings ok, logs a failed ping and a skipped one, and never logs the URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { SECBOT_HEARTBEAT_URLS: URLS };
    const seen: string[] = [];
    const ok = await pingRoutineHeartbeat(env, "owner", "heartbeat", async (input) => {
      seen.push(String(input));
      return new Response("ok");
    });
    const failed = await pingRoutineHeartbeat(
      env,
      "household",
      "heartbeat",
      async () => new Response("no", { status: 503 }),
    );
    const thrown = await pingRoutineHeartbeat(env, "owner", "briefing", async () => {
      throw new Error("network down");
    });
    const skipped = await pingRoutineHeartbeat({}, "second", "heartbeat");
    expect([ok, failed, thrown, skipped]).toEqual(["ok", "failed", "failed", "skipped"]);
    expect(seen).toEqual(["https://heartbeat.example.test/owner-cell"]);
    const lines = loggedEvents(log.mock.calls);
    expect(lines).toEqual([
      {
        event: "heartbeat.ping",
        level: "info",
        cell: "owner",
        routine: "heartbeat",
        outcome: "ok",
        http_status: 200,
      },
      {
        event: "heartbeat.ping",
        level: "info",
        cell: "household",
        routine: "heartbeat",
        outcome: "failed",
        http_status: 503,
      },
      {
        event: "heartbeat.ping",
        level: "info",
        cell: "owner",
        routine: "briefing",
        outcome: "failed",
        http_status: null,
      },
      {
        event: "heartbeat.ping",
        level: "info",
        cell: "second",
        routine: "heartbeat",
        outcome: "skipped",
        http_status: null,
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("example.test");
  });

  it("stores the last run, and moves the last ok time only on a 2xx ping", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    let clock = Date.now();
    let answer = 200;
    const env = { SECBOT_HEARTBEAT_URLS: "owner:https://heartbeat.example.test/owner-cell" };
    const fetcher = async () => new Response("x", { status: answer });
    // Each life starts after the stored wake time, so the heartbeat runs once on open.
    const life = async () => {
      const test = await openTestCell({ storage, env, now: () => clock, fetch: fetcher });
      opened.push(test);
      return test;
    };
    let test = await life();
    expect(await heartbeatState(test.cell.harness)).toEqual({
      lastAt: null,
      lastOutcome: null,
      lastOkAt: null,
      lastHttpStatus: null,
    });
    await test.cell.close();

    clock += HEARTBEAT_EVERY_MS + 1_000;
    const okAt = clock;
    test = await life();
    const first = test;
    await until(async () => (await heartbeatState(first.cell.harness)).lastAt === okAt);
    expect(await heartbeatState(test.cell.harness)).toEqual({
      lastAt: okAt,
      lastOutcome: "ok",
      lastOkAt: okAt,
      lastHttpStatus: 200,
    });
    await test.cell.close();

    clock += HEARTBEAT_EVERY_MS + 1_000;
    answer = 503;
    const failedAt = clock;
    test = await life();
    const second = test;
    await until(async () => (await heartbeatState(second.cell.harness)).lastAt === failedAt);
    const state = await heartbeatState(test.cell.harness);
    expect(state).toEqual({
      lastAt: failedAt,
      lastOutcome: "failed",
      lastOkAt: okAt,
      lastHttpStatus: 503,
    });
    expect(JSON.stringify(state)).not.toContain("example.test");
  });
});
