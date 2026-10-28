// Restart with a failure note: the lead reads the failed transcript, restarts the job once with a
// note, the old run's task settles aborted without touching the new run's row, and the new
// subagent gets the note and the brief and can search the old transcript (AC-17).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { entriesOf, entryRole, entryText } from "./job-helpers.ts";
import { jobResponder } from "./responders.ts";
import { job, leadCalls, startPausedJob } from "./escalation-helpers.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const NOTE = "household_read refused the list name twice; try the shopping list instead.";

/** The first run fails the same way three times; a restarted run answers. */
export const failsThenAnswers: Responder = (request) => {
  if (request.role !== "research") return jobResponder(request);
  if (/Failure note from the earlier attempt/.test(request.lastText))
    return fauxAssistantMessage([fauxText("Found three flights this time.")]);
  return fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
    stopReason: "toolUse",
  });
};

describe("restart with a failure note", () => {
  it("shows the lead the failed transcript with its tool errors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failsThenAnswers) });
    const t = test;
    await startPausedJob(t);
    const transcript = await leadCalls(t, "job_transcript", { job: 1 });
    expect(transcript).toContain("user: find flights");
    expect(transcript).toContain('job: [calls household_read {"document":"no such list!"}]');
    expect(transcript).toContain("tool household_read error:");
    expect(transcript.length).toBeLessThanOrEqual(4_000);
  });

  it("aborts the old run, keeps the number and row, and the new run answers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failsThenAnswers) });
    const t = test;
    await startPausedJob(t);
    const before = await job(t);
    const oldTask = before?.taskId;
    const oldConversation = before?.conversationId;
    if (oldTask === null || oldTask === undefined) throw new Error("no task");
    const said = await leadCalls(t, "restart_job", { job: 1, note: NOTE });
    expect(said).toBe(
      "job 1 restarts with a fresh subagent and your note; this was its one restart.",
    );
    const settled = await t.cell.harness.waitForTask(oldTask, BACKGROUND_CONTEXT);
    expect(settled.state.outcome.status).toBe("aborted");
    await until(async () => (await job(t))?.status === "done");
    const row = await job(t);
    expect(row).toMatchObject({
      number: 1,
      status: "done",
      attempts: { raises: 0, restarts: 1 },
      pause: null,
      result: { kind: "routine", text: "Found three flights this time." },
      runs: [{ conversationId: oldConversation, taskId: oldTask, note: NOTE }],
    });
    expect(row?.conversationId).not.toBe(oldConversation);
    expect(String(row?.taskId)).not.toBe(String(oldTask));
    expect(loggedEvents(log.mock.calls).find((e) => e.event === "job.restarted")).toMatchObject({
      job: 1,
      attempts: 1,
      note_chars: NOTE.length,
    });
    expect(JSON.stringify(loggedEvents(log.mock.calls))).not.toContain(NOTE);
  });

  it("gives the new subagent the note and the brief as its first input", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failsThenAnswers) });
    const t = test;
    await startPausedJob(t);
    await leadCalls(t, "restart_job", { job: 1, note: NOTE });
    await until(async () => (await job(t))?.status === "done");
    const id = (await job(t))?.conversationId;
    if (id === null || id === undefined) throw new Error("no conversation");
    const conversation = await t.cell.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("no conversation");
    const first = (await entriesOf(conversation)).find((entry) => entryRole(entry) === "user");
    expect(first === undefined ? "" : entryText(first)).toBe(
      `Failure note from the earlier attempt:\n${NOTE}\n\nBrief:\nfind flights`,
    );
  });

  it("refuses a second restart while the raise is left", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway((request) =>
        request.role === "research"
          ? fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
              stopReason: "toolUse",
            })
          : jobResponder(request),
      ),
    });
    const t = test;
    await startPausedJob(t);
    await leadCalls(t, "restart_job", { job: 1, note: NOTE });
    await until(
      async () => (await job(t))?.status === "paused" && (await job(t))?.runs.length === 1,
    );
    expect(await leadCalls(t, "restart_job", { job: 1, note: NOTE })).toBe(
      "Refused: job 1 has used its restart; a raise with set_job is left.",
    );
    expect((await job(t))?.attempts).toEqual({ raises: 0, restarts: 1 });
  });
});
