// The heartbeat routine's ping: once per wake to the cell's own URL from the runtime var, skipped
// without one, a failure logged, and the URL never in a log line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatUrl, pingRoutineHeartbeat } from "../src/heartbeat.ts";
import { loggedEvents } from "./fixtures.ts";

const URLS =
  "owner:https://heartbeat.example.test/owner-cell,household:https://heartbeat.example.test/household-cell,owner.briefing:https://heartbeat.example.test/briefing,second:http://plain.example.test/x";

afterEach(() => vi.restoreAllMocks());

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
        cell: "owner",
        routine: "heartbeat",
        outcome: "ok",
        http_status: 200,
      },
      {
        event: "heartbeat.ping",
        cell: "household",
        routine: "heartbeat",
        outcome: "failed",
        http_status: 503,
      },
      {
        event: "heartbeat.ping",
        cell: "owner",
        routine: "briefing",
        outcome: "failed",
        http_status: null,
      },
      {
        event: "heartbeat.ping",
        cell: "second",
        routine: "heartbeat",
        outcome: "skipped",
        http_status: null,
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("example.test");
  });
});
