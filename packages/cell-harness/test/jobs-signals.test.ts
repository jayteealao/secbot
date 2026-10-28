// The slice's signals, each one JSON line through logEvent with its fields: a job's start, finish,
// waiting result, wake notice, pull, and effort change, the closing of its usage watch, a receipt's
// start and finish, the bookmark's record and resume, and the steered input. No line carries a
// brief, a result, a note, or a secret's value.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc } from "../src/docs.ts";
import { createJobRow } from "../src/job-board.ts";
import { QUEUED_LONG_MS } from "../src/job-task.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  fauxAssistantMessage,
  fauxText,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const BRIEF = "Brief text that must stay out of the log: kale-7731.";
const ANSWER = "Result text that must stay out of the log: plum-4410.";
const NOTE = "Note text that must stay out of the log: fig-2208.";

describe("the job signals", () => {
  it("logs each signal with its fields and no brief, result, or note text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    const respond: Responder = (request) => {
      if (request.role === "research") return fauxAssistantMessage([fauxText(ANSWER)]);
      // The health job answers with nothing: a failed job wakes the lead at once.
      if (request.role === "health") return fauxAssistantMessage([fauxText("")]);
      return jobResponder(request);
    };
    test = await openTestCell({
      gateway: createFauxGateway(hold.wrap(respond)),
      household: createHouseholdStub(),
    });
    const t = test;
    const events = () => loggedEvents([...log.mock.calls, ...warn.mock.calls]);
    const one = (name: string) => events().filter((event) => event.event === name);

    // A research job: started, its effort changed while it runs, then finished and waiting.
    await (
      await t.cell.submit(
        startJobLine({ title: "kale", brief: BRIEF, template: "research" }),
        "sig-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    expect(one("input.steered")[0]).toMatchObject({
      cell: "owner",
      request_id: "sig-1",
      busy: false,
      when_busy: "steer",
    });
    await until(() => hold.waiting("research") === 1);
    expect(one("job.started")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      template: "research",
      tier: "mid",
      effort_requested: "medium",
      effort_applied: expect.any(String),
      priority: "routine",
      task_id: expect.any(String),
      conversation_id: expect.any(String),
      brief_chars: BRIEF.length,
    });
    await (await t.cell.submit('CALL set_job {"job":1,"tier":"cheap"}', "sig-2")).wait(
      BACKGROUND_CONTEXT,
    );
    expect(one("job.effort_changed")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      from_tier: "mid",
      to_tier: "cheap",
      effort_requested: "medium",
      effort_applied: expect.any(String),
    });
    hold.release("research");
    await until(() => one("job.result_waiting").length === 1);
    expect(one("job.finished")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      template: "research",
      tier: "cheap",
      outcome: "answered",
      cost_usd: expect.any(Number),
      duration_ms: expect.any(Number),
    });
    expect(one("job.result_waiting")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      kind: "routine",
      result_chars: ANSWER.length,
    });
    await until(() => one("job.watch_closed").length === 1);
    expect(one("job.watch_closed")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      conversation_id: expect.any(String),
      open_watches: expect.any(Number),
    });
    await (await t.cell.submit('CALL job_result {"job":1}', "sig-3")).wait(BACKGROUND_CONTEXT);
    expect(one("job.result_pulled")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      kind: "routine",
      waited_ms: expect.any(Number),
    });

    // A failed job wakes the lead.
    await (
      await t.cell.submit(
        startJobLine({ title: "sleep", brief: BRIEF, template: "health" }),
        "sig-4",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(() => one("job.wake_sent").length === 1);
    expect(one("job.wake_sent")[0]).toMatchObject({
      cell: "owner",
      job: 2,
      kind: "failure",
      waited_ms: expect.any(Number),
    });

    // A receipt's start and finish.
    await (await t.cell.submit("CALL household_read {}", "sig-5")).wait(BACKGROUND_CONTEXT);
    await until(() => one("receipt.finished").length === 1);
    expect(one("receipt.started")[0]).toMatchObject({
      cell: "owner",
      receipt: "r1",
      tool: "household_read",
      turn: expect.any(Number),
    });
    expect(one("receipt.finished")[0]).toMatchObject({
      cell: "owner",
      receipt: "r1",
      tool: "household_read",
      outcome: "ok",
      duration_ms: expect.any(Number),
    });

    // The bookmark: a line that interrupts the busy lead, then the lead resumes.
    hold.hold("lead");
    const busy = await t.cell.submit("first", "sig-6");
    await until(() => hold.waiting("lead") === 1);
    const steered = await t.cell.submit("second", "sig-7");
    expect(one("bookmark.recorded")[0]).toMatchObject({
      cell: "owner",
      turn: expect.any(Number),
      receipts: expect.any(Number),
      jobs: expect.any(Number),
      replaced: false,
    });
    expect(one("input.steered").find((event) => event.request_id === "sig-7")).toMatchObject({
      busy: true,
    });
    hold.release("lead");
    await busy.wait(BACKGROUND_CONTEXT);
    await steered.wait(BACKGROUND_CONTEXT);
    await (
      await t.cell.submit(`CALL note_bookmark ${JSON.stringify({ sentence: NOTE })}`, "sig-8")
    ).wait(BACKGROUND_CONTEXT);
    await (await t.cell.submit("CALL resume_work {}", "sig-9")).wait(BACKGROUND_CONTEXT);
    expect(one("bookmark.resumed")[0]).toMatchObject({
      cell: "owner",
      turn: expect.any(Number),
      waited_ms: expect.any(Number),
      had_note: true,
    });

    // No line carries a brief, a result, or a note.
    const everything = JSON.stringify(events());
    for (const text of ["kale-7731", "plum-4410", "fig-2208"]) {
      expect(everything).not.toContain(text);
    }
  }, 30_000);

  it("warns once when a job starts more than 10 minutes after it was created, and not otherwise", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const { harness } = test.cell;
    const JobTask = test.cell.tasks?.job;
    if (JobTask === undefined) throw new Error("no job task");
    const startAt = async (createdAt: number) =>
      harness.commit(async (tx) => {
        const row = await createJobRow(tx, {
          title: "late",
          brief: BRIEF,
          priority: "routine",
          deadline: null,
          template: "research",
          tier: "mid",
          effort: { requested: "medium", applied: "medium" },
          owner: "owner",
          turn: null,
          createdAt,
        });
        await tx.createTask(
          JobTask,
          { number: row.number, attempt: 0 },
          {
            ownership: { kind: "conversation" },
            conversationId: ROOT_CONVERSATION_ID,
            background: true,
          },
        );
        return row.number;
      }, BACKGROUND_CONTEXT);
    const late = await startAt(Date.now() - QUEUED_LONG_MS - 60_000);
    const fresh = await startAt(Date.now());
    const done = async (n: number) =>
      (await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs[String(n)]?.result != null;
    await until(async () => (await done(late)) && (await done(fresh)));
    const queued = loggedEvents(warn.mock.calls).filter(
      (event) => event.event === "job.queued_long",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ cell: "owner", job: late, level: "warn" });
    expect(queued[0]?.queued_ms).toBeGreaterThanOrEqual(QUEUED_LONG_MS);
    expect(JSON.stringify(queued)).not.toContain("kale-7731");
  });
});
