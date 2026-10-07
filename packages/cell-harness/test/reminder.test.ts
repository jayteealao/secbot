// Reminders (AC-18 proxy in the harness): the lead model's own set_reminder call creates one
// reminder routine; at its time the reminder reaches the lead once as a follow-up input with a
// fixed request id, and the lead's relayed answer streams to an open session. The live check with
// the real lead model and the CLI runs on the test cell.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReminder, REMINDER_PREFIX, reminderProblem } from "../src/reminder.ts";
import { timeSection, timeZoneOf } from "../src/sections.ts";
import type { Frame } from "../src/session-stream.ts";
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

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 9, 7, 17, 0, 0);

describe("reminder times", () => {
  it("refuses a time without an offset, in the past, more than a year ahead, or an empty text", () => {
    expect(reminderProblem("2026-10-07T18:00:00+01:00", "oven", NOW)).toBeUndefined();
    expect(reminderProblem("2026-10-07T18:00:00Z", "oven", NOW)).toBeUndefined();
    expect(reminderProblem("2026-10-07T18:00", "oven", NOW)).toContain("offset");
    expect(reminderProblem("2026-10-07T15:00:00Z", "oven", NOW)).toContain("past");
    expect(reminderProblem("2028-10-07T18:00:00Z", "oven", NOW)).toContain("year");
    expect(reminderProblem("2026-10-07T18:00:00Z", " ", NOW)).toContain("text");
    expect(reminderProblem("2026-10-07T18:00:00Z", "x".repeat(501), NOW)).toContain("longer");
    expect(reminderProblem("2026-13-45T18:00:00Z", "oven", NOW)).toContain("valid");
  });

  it("gives the lead the time in UTC and in the person's zone", () => {
    expect(timeZoneOf({ SECBOT_TIME_ZONE: "Europe/London" })).toBe("Europe/London");
    expect(timeZoneOf({ SECBOT_TIME_ZONE: "Not/AZone" })).toBe("UTC");
    expect(timeZoneOf({})).toBe("UTC");
    const text = timeSection(NOW + 42_000, "Europe/London");
    expect(text).toContain("2026-10-07T17:00Z (UTC)");
    expect(text).toContain("18:00");
    expect(text).toContain("Europe/London");
  });
});

describe("set_reminder", () => {
  it("sets one reminder from the lead's call; at its time the lead receives it once and relays it to the session", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let at = "";
    const responder = (request: FauxRequest) => {
      if (request.role !== "lead") return fauxAssistantMessage([fauxText("n/a")]);
      if (request.last?.role === "toolResult") {
        return fauxAssistantMessage([fauxText(`Done: ${request.lastText.slice(0, 60)}`)]);
      }
      if (request.lastText.startsWith(REMINDER_PREFIX)) {
        return fauxAssistantMessage([fauxText(`Reminder: ${request.lastText.slice(11)}`)]);
      }
      if (request.lastText.includes("remind me")) {
        at = new Date(Date.now() + 600).toISOString();
        return fauxAssistantMessage(
          [fauxToolCall("set_reminder", { at, text: "check the oven" })],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage([fauxText("Hello.")]);
    };
    let wakeChanges = 0;
    test = await openTestCell({
      gateway: createFauxGateway(responder),
      onWakeChange: () => wakeChanges++,
    });
    const t = test;
    const frames: Frame[] = [];
    const stream = await t.cell.session((frame) => frames.push(frame));
    await (await t.cell.submit("please remind me about the oven", "req-reminder-1")).wait(
      BACKGROUND_CONTEXT,
    );
    expect(t.gateway.requests.at(-1)?.lastText).toContain("Reminder set for");
    const reminderTasks = (await t.cell.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === "secbot.routine:reminder",
    );
    expect(reminderTasks).toHaveLength(1);
    expect(wakeChanges).toBeGreaterThanOrEqual(1);
    expect((await t.cell.wakes()).summary.wakes.map((wake) => wake.source)).toContain("reminder");

    await until(() =>
      frames.some((frame) => frame.type === "answer" && frame.text === "Reminder: check the oven"),
    );
    await stream.stop();
    const reminderRequests = t.gateway.requests.filter((request) =>
      request.lastText.startsWith(REMINDER_PREFIX),
    );
    expect(reminderRequests).toHaveLength(1);
    expect(reminderRequests[0]?.lastText).toBe("[reminder] check the oven");

    const lines = loggedEvents(log.mock.calls);
    expect(lines.find((line) => line.event === "reminder.set")).toMatchObject({
      cell: "owner",
      wake_at: new Date(Date.parse(at)).toISOString(),
    });
    expect(lines.find((line) => line.event === "routine.fired")).toMatchObject({
      routine: "reminder",
      outcome: "delivered",
      next_wake_at: null,
    });
    // The reminder text stays out of the logs.
    expect(JSON.stringify(lines.filter((line) => line.event !== "model.call"))).not.toContain(
      "oven",
    );
  });

  it("creates one reminder per tool call, so a rerun after a crash creates none", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const t = test;
    const create = () =>
      t.cell.harness.commit(
        (tx) => createReminder(tx, t.cell.reminders, "tool-7:call-1", Date.now() + 60_000, "oven"),
        BACKGROUND_CONTEXT,
      );
    const first = await create();
    const second = await create();
    expect(first.created).toBe(true);
    expect(second).toEqual({ taskId: first.taskId, created: false });
  });

  it("answers a refused time with an error result and sets nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = createFauxGateway((request) =>
      request.role === "lead" && request.last?.role !== "toolResult"
        ? fauxAssistantMessage(
            [fauxToolCall("set_reminder", { at: "tomorrow at six", text: "oven" })],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage([fauxText(request.lastText)]),
    );
    test = await openTestCell({ gateway });
    await (await test.cell.submit("remind me", "req-reminder-2")).wait(BACKGROUND_CONTEXT);
    expect(gateway.requests.at(-1)?.lastText).toContain("Not set");
    const tasks = (await test.cell.harness.inspect(BACKGROUND_CONTEXT)).tasks;
    expect(tasks.filter(({ record }) => record.kind === "secbot.routine:reminder")).toHaveLength(0);
  });
});
