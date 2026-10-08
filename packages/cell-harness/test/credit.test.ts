// The key's credit limit is reached. The request is kept, the job pauses (retried at the
// capped one-minute pace), the owner is alerted once, at once, and the job resumes when the limit
// rises. The 402 text is what the installed pi-ai produced against the local OpenRouter stub.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_PAUSE_TEXT, isCreditError, rewriteCreditError } from "../src/credit-pause.ts";
import { ModelHealthDoc } from "../src/docs.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type TestCell,
} from "./fixtures.ts";
import { ALERT_ENV, incidentStub } from "./outage-fixtures.ts";

const MINUTE = 60_000;
const CREDIT_402 =
  '402 {"error":{"code":402,"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits"}}';

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

describe("credit limit", () => {
  it("turns a 402 into a retryable pause and leaves other errors alone", () => {
    const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: CREDIT_402 });
    expect(isRetryableAssistantError(failed)).toBe(false);
    const paused = rewriteCreditError(failed);
    expect(paused.errorMessage).toBe(CREDIT_PAUSE_TEXT);
    expect(isRetryableAssistantError(paused)).toBe(true);
    expect(isCreditError(paused)).toBe(true);
    const throttled = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "429 slow down",
    });
    expect(rewriteCreditError(throttled)).toBe(throttled);
    const answer = fauxAssistantMessage([fauxText("402 is a number")]);
    expect(rewriteCreditError(answer)).toBe(answer);
  });

  it("treats a 403 like a 402: a credit pause, not a failure", () => {
    const forbidden = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: '403 {"error":{"code":403,"message":"Key limit exceeded"}}',
    });
    const paused = rewriteCreditError(forbidden);
    expect(paused.errorMessage).toBe(CREDIT_PAUSE_TEXT);
    expect(isRetryableAssistantError(paused)).toBe(true);
    // A number in an answer's text is not a status.
    const answer = fauxAssistantMessage([fauxText("403 is a number too")]);
    expect(rewriteCreditError(answer)).toBe(answer);
  });

  it("keeps the request, pauses, alerts once, and resumes when the limit rises", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let limitRaised = false;
    const gateway = createFauxGateway(() =>
      limitRaised
        ? fauxAssistantMessage([fauxText("Resumed after the limit rose.")])
        : fauxAssistantMessage([], { stopReason: "error", errorMessage: CREDIT_402 }),
    );
    const { incidents, fetcher } = incidentStub();
    test = await openTestCell({ gateway, env: ALERT_ENV, now: () => Date.now(), fetch: fetcher });
    const frames: unknown[] = [];
    const session = await test.cell.session((frame) => frames.push(frame));
    const start = Date.now();
    const submission = await test.cell.submit("Plan the week", "credit-1");

    for (let minute = 0; minute < 30; minute++) await vi.advanceTimersByTimeAsync(MINUTE);
    expect((await submission.status(BACKGROUND_CONTEXT)).status).not.toBe("unanswered");
    expect((await submission.status(BACKGROUND_CONTEXT)).status).not.toBe("done");
    await test.cell.monitor.settled();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.body.summary).toBe("Secbot owner cell: model credit limit reached");
    expect((incidents[0]?.at ?? 0) - start).toBeLessThan(MINUTE);
    const paused = await test.cell.harness.snapshot(ModelHealthDoc, BACKGROUND_CONTEXT);
    expect(paused).toMatchObject({ state: "credit", waiting: true });
    // Paused, not spinning: about one attempt per minute once the backoff reaches its cap.
    expect(gateway.requests.length).toBeLessThan(40);

    limitRaised = true;
    let status = (await submission.status(BACKGROUND_CONTEXT)).status;
    for (let step = 0; step < 70 && status !== "done"; step++) {
      await vi.advanceTimersByTimeAsync(1_000);
      status = (await submission.status(BACKGROUND_CONTEXT)).status;
    }
    expect(status).toBe("done");
    await test.cell.monitor.settled();
    await vi.advanceTimersByTimeAsync(1_000);
    await session.stop();
    expect(incidents).toHaveLength(1);
    expect(frames).toContainEqual({ type: "waiting", on: true });
    expect(frames).toContainEqual({ type: "waiting", on: false });
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines.filter((line) => line.event === "model.health").map((line) => line.state)).toEqual(
      ["credit", "ok"],
    );
    expect(lines.some((line) => line.event === "model.call" && line.credit === true)).toBe(true);
  }, 60_000);
});
