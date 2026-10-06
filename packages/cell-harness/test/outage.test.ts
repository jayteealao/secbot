// OpenRouter failing with 429, 5xx, and timeouts for 20 minutes. The request is kept with
// no retry ceiling and the turn is answered once the model returns; after 15 minutes exactly one
// Better Stack incident is sent and sessions show "waiting for the model" until recovery.
// The clock is Vitest's fake clock, which drives pi-durable's retry sleep (the harness `now`) and
// the model-health monitor. The error texts are the ones the installed pi-ai produced against the
// local OpenRouter stub (gateway.test.ts proves that wire path).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelHealthDoc } from "../src/docs.ts";
import type { Frame } from "../src/session-stream.ts";
import { RETRY_POLICY } from "../src/settings.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type TestCell,
} from "./fixtures.ts";
import { ALERT_ENV, FAILURES, incidentStub } from "./outage-fixtures.ts";

const MINUTE = 60_000;

let test: TestCell | undefined;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("model outage", () => {
  it("has no retry ceiling and a one-minute backoff cap", () => {
    expect(RETRY_POLICY).toEqual({
      enabled: true,
      maxRetries: Number.MAX_SAFE_INTEGER,
      baseDelayMs: 2000,
      maxAgentDelayMs: 60000,
    });
  });

  it("keeps the request for 20 minutes of failures, alerts once at 15 minutes, then answers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = Date.now();
    const failUntil = start + 20 * MINUTE;
    let attempt = 0;
    const gateway = createFauxGateway(() => {
      const failure = FAILURES[attempt++ % FAILURES.length] ?? "";
      return Date.now() < failUntil
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: failure })
        : fauxAssistantMessage([fauxText("Back again: here is your answer.")]);
    });
    const { incidents, fetcher } = incidentStub();
    test = await openTestCell({ gateway, env: ALERT_ENV, now: () => Date.now(), fetch: fetcher });
    const frames: { at: number; frame: Frame }[] = [];
    const session = await test.cell.session((frame) => frames.push({ at: Date.now(), frame }));
    const submission = await test.cell.submit("What is on today?", "outage-1");

    let settled = await submission.status(BACKGROUND_CONTEXT);
    while (settled.status !== "done" && Date.now() < start + 25 * MINUTE) {
      expect(settled.status).not.toBe("unanswered");
      await vi.advanceTimersByTimeAsync(1_000);
      settled = await submission.status(BACKGROUND_CONTEXT);
    }
    await test.cell.monitor.settled();
    await vi.advanceTimersByTimeAsync(1_000);
    await session.stop();

    expect(settled.status).toBe("done");
    const failures = gateway.requests.length - 1;
    expect(failures).toBeGreaterThan(3);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];
    expect(incident?.auth).toBe("Bearer test-token");
    expect(incident?.body).toMatchObject({
      summary: "Secbot owner cell: waiting for the model for 15 minutes",
      requester_email: "owner@example.com",
      push: true,
      email: true,
    });
    const alertedAfter = (incident?.at ?? 0) - start;
    expect(alertedAfter).toBeGreaterThanOrEqual(15 * MINUTE);
    expect(alertedAfter).toBeLessThan(17 * MINUTE);

    const waiting = frames.filter((entry) => entry.frame.type === "waiting");
    expect(waiting.map((entry) => entry.frame)).toEqual([
      { type: "waiting", on: true },
      { type: "waiting", on: false },
    ]);
    expect(frames.some((entry) => entry.frame.type === "answer")).toBe(true);

    const health = await test.cell.harness.snapshot(ModelHealthDoc, BACKGROUND_CONTEXT);
    expect(health).toMatchObject({ state: "ok", waiting: false, alertedAt: null });
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines.filter((line) => line.event === "model.health").map((line) => line.state)).toEqual(
      ["failing", "ok"],
    );
    expect(lines.filter((line) => line.event === "model.alert")).toEqual([
      expect.objectContaining({ kind: "outage", outcome: "sent", http_status: 201 }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("test-token");
    expect(
      lines.filter((line) => line.event === "model.call" && line.stop_reason === "error").length,
    ).toBe(failures);
  }, 60_000);

  it("logs the alert as skipped when no incidents token is set", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = Date.now();
    const gateway = createFauxGateway(() =>
      Date.now() < start + 16 * MINUTE
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FAILURES[0] ?? "" })
        : fauxAssistantMessage([fauxText("ok")]),
    );
    test = await openTestCell({ gateway, now: () => Date.now() });
    const submission = await test.cell.submit("hi", "outage-2");
    while ((await submission.status(BACKGROUND_CONTEXT)).status !== "done") {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await test.cell.monitor.settled();
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines.filter((line) => line.event === "model.alert")).toEqual([
      expect.objectContaining({ kind: "outage", outcome: "skipped" }),
    ]);
  }, 60_000);
});
