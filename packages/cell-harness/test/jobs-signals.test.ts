// The slice's signals, each one JSON line through logEvent with its fields: a job's start, finish,
// waiting result, wake notice, pull, and effort change, the closing of its usage watch, a receipt's
// start and finish, the bookmark's record and resume, the steered input, each job a stop ends,
// the stop's end and a job it left running, a restart, a reorder, and the capacity warning. No
// line carries a brief, a title, a result, a note, or a secret's value; every designed signal name
// is logged from some package source file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionFailure, type DecisionModels } from "../src/decision-model.ts";
import { JobBoardDoc, StopDoc } from "../src/docs.ts";
import { createJobRow } from "../src/job-board.ts";
import { QUEUED_LONG_MS } from "../src/job-task.ts";
import { stopJobs } from "../src/stop.ts";
import { failingResearch, job, leadCalls } from "./escalation-helpers.ts";
import {
  cleanContent,
  createFauxGateway,
  createHouseholdStub,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  passingDecision,
  type Responder,
  resultReviewer,
  reviewerResponder,
  type TestCell,
  until,
  verdictJson,
} from "./fixtures.ts";
import { FIXTURE_ORDER, FIXTURE_PAGES } from "./injection-fixtures.ts";
import { createHold, jobResponder, RESEARCH_JOB, startJobLine } from "./responders.ts";
import { openPair, proposeFrom } from "./shared-pair.ts";

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
      // The health job's request is refused for good (an empty reply now pauses a job instead):
      // a failed job wakes the lead at once.
      if (request.role === "health") {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Bad request" });
      }
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

describe("the escalation, review, and question signals", () => {
  const SECRET_WORDS = /kale-7731|plum-4410|fig-2208|pear-5512|lime-9930/;
  const QUESTION = "Question text that must stay out of the log: pear-5512.";
  const REPLY = "Answer text that must stay out of the log: lime-9930.";

  it("logs a pause, a raise, a restart, and an escalation end with their fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: BRIEF, template: "research" }), "s-1")
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.status === "paused");
    await leadCalls(t, "set_job", { job: 1, tier: "frontier" });
    await until(async () => (await job(t))?.status === "paused");
    await leadCalls(t, "restart_job", { job: 1, note: NOTE });
    await until(async () => (await job(t))?.status === "paused");
    await leadCalls(t, "set_job", { job: 1, effort: "high" });
    await until(async () => (await job(t))?.status === "failed");
    const events = loggedEvents(log.mock.calls);
    const of = (name: string) => events.filter((each) => each.event === name);
    expect(of("job.paused")).toEqual([
      expect.objectContaining({ cell: "owner", job: 1, reason: "loop", streak: 3 }),
      expect.objectContaining({ job: 1, reason: "loop" }),
      expect.objectContaining({ job: 1, reason: "loop" }),
      expect.objectContaining({ job: 1, reason: "escalation", cap_usd: expect.any(Number) }),
    ]);
    expect(of("job.paused")[0]).toMatchObject({ cost_usd: expect.any(Number), cap_usd: 1 });
    expect(of("job.raised")).toEqual([
      expect.objectContaining({ cell: "owner", job: 1, attempts: 1 }),
    ]);
    expect(of("job.restarted")).toEqual([
      expect.objectContaining({ job: 1, attempts: 2, note_chars: NOTE.length }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(SECRET_WORDS);
  });

  it("logs a question, its answer, a request, a lead's mark, and a review with their fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const respond: Responder = (request) => {
      if (request.role === "research") {
        if (
          request.last?.role === "toolResult" &&
          request.lastText.startsWith("The lead answers")
        ) {
          return fauxAssistantMessage(
            [fauxToolCall("request_job", { title: "b", brief: BRIEF, template: "research" })],
            { stopReason: "toolUse" },
          );
        }
        if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText(ANSWER)]);
        if (request.lastText.includes("kale-7731") && request.last?.role === "user") {
          return fauxAssistantMessage([fauxToolCall("ask_lead", { question: QUESTION })], {
            stopReason: "toolUse",
          });
        }
      }
      if (request.role === "lead" && request.lastText.startsWith("[job 1 question:")) {
        return fauxAssistantMessage([fauxToolCall("answer_job", { job: 1, answer: REPLY })], {
          stopReason: "toolUse",
        });
      }
      return jobResponder(request);
    };
    test = await openTestCell({
      gateway: createFauxGateway(
        resultReviewer(respond, () => ({ verdict: "reject", reason: "it does not match" })),
      ),
    });
    const t = test;
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: BRIEF, template: "research" }), "s-2")
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.result != null);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    await leadCalls(t, "mark_risky", { job: 1, reason: "it quotes prices" });
    await until(async () => (await job(t))?.review?.status === "rejected");
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const events = loggedEvents(log.mock.calls);
    const of = (name: string) => events.filter((each) => each.event === name);
    expect(of("job.question_asked")).toEqual([
      expect.objectContaining({ cell: "owner", job: 1, to_person: false }),
    ]);
    expect(of("job.answered")).toEqual([
      expect.objectContaining({ cell: "owner", job: 1, by: "lead", answer_chars: REPLY.length }),
    ]);
    expect(of("job.requested")).toEqual([
      expect.objectContaining({ cell: "owner", job: 2, by_job: 1 }),
    ]);
    expect(of("job.risky_marked")).toEqual([
      expect.objectContaining({ cell: "owner", job: 1, by: "lead", reasons: 1 }),
    ]);
    expect(of("job.review_rejected")).toEqual([
      expect.objectContaining({ cell: "owner", job: 1, reviewer_model: expect.any(String) }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(SECRET_WORDS);
  });

  it("logs code's risky mark and a passed review", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(resultReviewer(jobResponder)) });
    const t = test;
    await (
      await t.cell.submit(startJobLine({ title: "a", brief: BRIEF, template: "health" }), "s-3")
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.review?.status === "passed");
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const events = loggedEvents(log.mock.calls);
    expect(events.filter((each) => each.event === "job.risky_marked")).toEqual([
      expect.objectContaining({ job: 1, by: "code", reasons: 1 }),
    ]);
    expect(events.filter((each) => each.event === "job.review_passed")).toEqual([
      expect.objectContaining({ job: 1, reviewer_model: expect.any(String) }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(SECRET_WORDS);
  });
});

describe("the content check signals", () => {
  const ORDER_FREE_LINES = FIXTURE_PAGES.clean.split("\n");
  const pricedCheck: DecisionModels = (adapter) => ({
    ...passingDecision(adapter),
    checkContent: async (state) => ({
      ...(await cleanContent()),
      ...(String(state.content).includes(FIXTURE_ORDER)
        ? { outcome: "hit" as const, choice: "injection" as const, score: 0.9 }
        : {}),
      costUsd: 0.001,
    }),
  });
  /** A research job that reads `page` twice (the second time beside `then`), then answers. */
  const reads = (page: keyof typeof FIXTURE_PAGES, then?: string): Responder => {
    let step = 0;
    return (request) => {
      if (request.role !== "research") return jobResponder(request);
      step++;
      if (step === 1) {
        return fauxAssistantMessage([fauxToolCall("read_fixture_page", { page })], {
          stopReason: "toolUse",
        });
      }
      if (step === 2) {
        return fauxAssistantMessage(
          [
            fauxToolCall("read_fixture_page", { page }),
            ...(then === undefined ? [] : [fauxToolCall(then, BROKER)]),
          ],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage([fauxText("Read it.")]);
    };
  };
  const BROKER = { secret: "health-test", method: "GET", path: "/v1/steps" };

  it("logs a checked read and one outside mark per kind, with no page text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway(reads("clean")),
      fixturePages: FIXTURE_PAGES,
      guard: { decision: pricedCheck },
    });
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "c-1")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.status === "done");
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const events = loggedEvents(log.mock.calls);
    const of = (name: string) => events.filter((each) => each.event === name);
    expect(of("content.checked").length).toBeGreaterThanOrEqual(1);
    expect(of("content.checked")[0]).toEqual({
      event: "content.checked",
      level: "info",
      cell: "owner",
      job: 1,
      tool: "read_fixture_page",
      source: "page",
      chunks: 1,
      content_bytes: new TextEncoder().encode(FIXTURE_PAGES.clean).length,
      cut: false,
      cost_usd: 0.001,
      duration_ms: expect.any(Number),
    });
    expect(of("job.outside_marked")).toEqual([
      {
        event: "job.outside_marked",
        level: "info",
        cell: "owner",
        job: 1,
        source: "page",
        tool: "read_fixture_page",
      },
    ]);
    for (const line of ORDER_FREE_LINES) expect(JSON.stringify(events)).not.toContain(line);
  });

  it("warns once when the check stops a job, with no page text", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway(reads("injected")),
      fixturePages: FIXTURE_PAGES,
      guard: { decision: pricedCheck },
    });
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "c-2")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.status === "blocked");
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const events = loggedEvents(warn.mock.calls);
    expect(events.filter((each) => each.event === "job.injection_stop")).toEqual([
      {
        event: "job.injection_stop",
        level: "warn",
        cell: "owner",
        job: 1,
        source: "page",
        tool: "read_fixture_page",
        outcome: "hit",
        chunk: 0,
        chunks: 1,
        content_bytes: new TextEncoder().encode(FIXTURE_PAGES.injected).length,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(FIXTURE_ORDER);
    expect(JSON.stringify(events)).not.toContain("lentil");
  });

  it("logs why the check failed when it stops a job on a failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingCheck: DecisionModels = (adapter) => ({
      ...passingDecision(adapter),
      checkContent: async () => {
        throw new DecisionFailure("http-429", 1);
      },
    });
    test = await openTestCell({
      gateway: createFauxGateway(reads("injected")),
      fixturePages: FIXTURE_PAGES,
      guard: { decision: failingCheck },
    });
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "c-3")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.status === "blocked");
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const events = loggedEvents(warn.mock.calls);
    expect(events.filter((each) => each.event === "content.check_failed")).toEqual([
      {
        event: "content.check_failed",
        level: "warn",
        cell: "owner",
        job: 1,
        tool: "read_fixture_page",
        outcome: "error",
        cause: "http-429",
        chunk: 0,
      },
    ]);
  });

  it("marks the guard's verdict line of a reviewed outside action", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = async (): Promise<never> => {
      throw new Error("not in this test");
    };
    test = await openTestCell({
      gateway: createFauxGateway(
        reviewerResponder(
          () => verdictJson("allow", "asked for"),
          resultReviewer(reads("clean", "broker_call")),
        ),
      ),
      fixturePages: FIXTURE_PAGES,
      secrets: {
        get: refused,
        broker: async () => ({ status: 200, body: "ok" }),
        list: async () => [],
        grant: refused,
        revoke: refused,
        add: refused,
        allowlist: refused,
        rotate: refused,
        redactionValues: async () => [],
      },
      guard: { decision: pricedCheck },
    });
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "c-3")).wait(BACKGROUND_CONTEXT);
    await until(() =>
      loggedEvents(log.mock.calls).some(
        (each) => each.event === "guard.verdict" && each.tool === "broker_call",
      ),
    );
    const verdicts = loggedEvents(log.mock.calls).filter((each) => each.event === "guard.verdict");
    expect(verdicts.find((each) => each.tool === "broker_call")).toMatchObject({
      outside_content: true,
      layer: "reviewer",
    });
    expect(verdicts.find((each) => each.tool === "read_fixture_page")).not.toHaveProperty(
      "outside_content",
    );
  });
});

describe("the stop, restart, and reorder signals", () => {
  const SECRET_TITLE = "title that must stay out of the log: plum-4410";
  const start = (t: TestCell, n: number) =>
    t.cell
      .submit(
        startJobLine({ title: `${SECRET_TITLE} ${n}`, brief: BRIEF, template: "research" }),
        `signal-job-${n}`,
      )
      .then((input) => input.wait(BACKGROUND_CONTEXT));
  const stopParts = (t: TestCell) => ({
    harness: t.cell.harness,
    root: t.cell.root,
    person: t.cell.person,
    now: t.cell.now,
  });

  it("logs each stopped job, the stop's end, a restart, and a reorder with their fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    hold.hold("research");
    await start(t, 1);
    await start(t, 2);
    await until(() => hold.waiting("research") === 2);

    const reordered = await t.cell.reorderJob(2, { urgent: true });
    expect(reordered.ok).toBe(true);
    const stopping = stopJobs(stopParts(t), "person", BACKGROUND_CONTEXT);
    await until(
      async () => (await t.cell.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
    );
    hold.release("research");
    await stopping;
    expect(await t.cell.resumeJob(1)).toMatchObject({ ok: true });
    await until(async () => (await job(t, 1))?.status === "done");

    const lines = loggedEvents(log.mock.calls);
    const of = (event: string) => lines.filter((line) => line.event === event);
    expect(of("job.reordered")).toEqual([
      {
        event: "job.reordered",
        level: "info",
        cell: "owner",
        job: 2,
        change: "urgent",
        place: 1,
        of: 2,
      },
    ]);
    expect(of("job.stopped")).toEqual([
      { event: "job.stopped", level: "info", cell: "owner", job: 1, by: "person" },
      { event: "job.stopped", level: "info", cell: "owner", job: 2, by: "person" },
    ]);
    expect(of("stop.done")).toEqual([
      {
        event: "stop.done",
        level: "info",
        cell: "owner",
        by: "person",
        jobs: 2,
        running: 0,
        turn: false,
        duration_ms: expect.any(Number),
      },
    ]);
    expect(of("job.resumed")).toEqual([
      { event: "job.resumed", level: "info", cell: "owner", job: 1, by: "person", resumes: 1 },
    ]);
    expect(of("stop.left_running")).toEqual([]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain("plum-4410");
    expect(text).not.toContain("kale-7731");
  });

  it("warns when a stop leaves a marked job running", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hold = createHold();
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const t = test;
    hold.hold("research");
    await start(t, 1);
    await until(() => hold.waiting("research") === 1);
    // A task that does not end on its abort: the stop finds it still running.
    vi.spyOn(t.cell.harness, "abortTask").mockResolvedValue(undefined as never);
    vi.spyOn(t.cell.harness, "waitForTask").mockResolvedValue(undefined as never);
    // It is not counted as stopped: the answer says it is still ending.
    expect(await stopJobs(stopParts(t), "owner", BACKGROUND_CONTEXT)).toEqual({
      jobs: 0,
      turn: false,
      running: 1,
    });
    expect(
      loggedEvents(warn.mock.calls).filter((line) => line.event === "stop.left_running"),
    ).toEqual([{ event: "stop.left_running", level: "warn", cell: "owner", jobs: 1 }]);
    expect((await job(t, 1))?.stop).toBeNull();
    vi.mocked(t.cell.harness.abortTask).mockRestore();
    vi.mocked(t.cell.harness.waitForTask).mockRestore();
    hold.release("research");
    await until(async () => (await job(t, 1))?.status === "done");
  });
});

describe("the shared-job signals", () => {
  const TITLE = "plan the May trip kiwi-5512";
  const SHARED_BRIEF = "Shared brief that must stay out of the log: pear-9033.";
  const PLAN = "Shared result that must stay out of the log: lime-6620.";

  it("logs each shared-job line with its fields, each dark path once, and no title, brief, or result", async () => {
    const pair = await openPair(
      () => fauxAssistantMessage([fauxText(PLAN)]),
      () => 0.01,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = () => loggedEvents([...log.mock.calls, ...warn.mock.calls]);
    const one = (name: string) => events().filter((event) => event.event === name);

    // Proposed by the owner's lead, offered to the other lead, joined, started, charged, relayed.
    await leadCalls(pair.owner, "propose_shared_job", {
      title: TITLE,
      brief: SHARED_BRIEF,
    });
    await until(async () => (await pair.row("owner", 1))?.shared?.household === 1);
    await pair.sync("second");
    await leadCalls(pair.second, "offer_shared", { job: 1 });
    expect(await pair.second.cell.answerShared(1, true)).toMatchObject({ ok: true });
    await until(async () => {
      await pair.sync("second");
      await pair.sync("owner");
      return (await pair.row("owner", 1))?.result?.text === PLAN;
    });
    await until(async () => {
      await pair.sync("second");
      await pair.sync("owner");
      return one("shared.charged").length >= 2;
    });
    expect(one("shared.proposed")[0]).toMatchObject({
      cell: "owner",
      job: 1,
      tier: "cheap",
    });
    expect(one("shared.offered")[0]).toMatchObject({
      cell: "second",
      job: 1,
      household: 1,
      from: "owner",
      payer: "half",
    });
    expect(one("shared.answered")[0]).toMatchObject({
      cell: "second",
      job: 1,
      household: 1,
      answer: "join",
    });
    expect(one("shared.started")).toEqual([
      expect.objectContaining({ cell: "household", job: 1, requester: "owner", other: "second" }),
    ]);
    for (const person of ["owner", "second"]) {
      expect(one("shared.charged").find((event) => event.cell === person)).toMatchObject({
        job: 1,
        household: 1,
        split: "half",
        usd: expect.any(Number),
      });
      expect(one("shared.relayed").find((event) => event.cell === person)).toMatchObject({
        job: 1,
        household: 1,
        kind: "routine",
      });
    }
    expect(one("shared.sync")[0]).toMatchObject({
      outcome: "ok",
      ops: expect.any(Number),
      acks: expect.any(Number),
      rows: expect.any(Number),
      duration_ms: expect.any(Number),
    });

    // An offer nobody answers for 24 hours: logged once.
    await proposeFrom(pair, "paint the hall");
    await pair.sync("owner");
    await pair.sync("second");
    expect(one("shared.offer_open")).toEqual([]);
    pair.clock.now += 24 * 60 * 60 * 1000;
    await pair.sync("second");
    await pair.sync("second");
    expect(one("shared.offer_open")).toEqual([
      expect.objectContaining({
        cell: "second",
        job: 2,
        household: 2,
        waited_ms: expect.any(Number),
      }),
    ]);
    expect(one("shared.offer_open")[0]?.waited_ms as number).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1000,
    );

    // An operation that goes out in three failed exchanges in a row: logged once.
    pair.setDown(true);
    await proposeFrom(pair, "fix the fence");
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await pair.sync("owner")).toMatchObject({ outcome: "failed" });
    }
    expect(one("shared.sync").some((event) => event.outcome === "failed")).toBe(true);
    expect(one("shared.ops_unsent")).toEqual([
      expect.objectContaining({
        cell: "owner",
        job: 3,
        op: "propose",
        failed_exchanges: 3,
        waited_ms: expect.any(Number),
        level: "warn",
      }),
    ]);
    pair.setDown(false);

    // No shared line carries a title, a brief, or a result.
    const lines = JSON.stringify(
      events().filter((event) => String(event.event).startsWith("shared.")),
    );
    for (const secret of [
      "kiwi-5512",
      "pear-9033",
      "lime-6620",
      "paint the hall",
      "fix the fence",
    ]) {
      expect(lines).not.toContain(secret);
    }
  });
});

describe("the capacity signal", () => {
  it("logs capacity.passed with its fields and no title or brief", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const slow: Responder = (request) => {
      if (request.role !== "research") return jobResponder(request);
      return request.last?.role === "toolResult"
        ? fauxAssistantMessage([fauxText("three options")])
        : fauxAssistantMessage([fauxToolCall("fixture_slow_lookup", { topic: "flights" })], {
            stopReason: "toolUse",
          });
    };
    test = await openTestCell({
      fixtureTools: { slowMs: 60_000 },
      gateway: createFauxGateway(slow),
    });
    const t = test;
    await t.cell.setCapacity(1, Date.UTC(2026, 9, 29));
    const lines = ["secret title one", "secret title two"]
      .map((title) => startJobLine({ title, brief: `brief of ${title}`, template: "research" }))
      .join("\n");
    await (await t.cell.submit(lines, "start-two")).wait(BACKGROUND_CONTEXT);
    const passed = () =>
      loggedEvents(log.mock.calls).filter((line) => line.event === "capacity.passed");
    await until(() => passed().length > 0);
    expect(passed()).toEqual([
      {
        event: "capacity.passed",
        level: "info",
        cell: "owner",
        parallel_jobs: 2,
        measured: 1,
        alerted: true,
      },
    ]);
  });
});

describe("every designed signal", () => {
  /** The signal names of the instrumentation plan, plus the dark-path warn lines. */
  const SIGNALS = [
    "job.started",
    "job.finished",
    "job.result_waiting",
    "job.wake_sent",
    "job.result_pulled",
    "job.effort_changed",
    "job.watch_closed",
    "job.queued_long",
    "receipt.started",
    "receipt.finished",
    "bookmark.recorded",
    "bookmark.resumed",
    "input.steered",
    "template.migrated",
    "job.paused",
    "job.restarted",
    "job.raised",
    "job.review_rejected",
    "job.injection_stop",
    "job.stopped",
    "stop.left_running",
    "capacity.passed",
  ];

  it("is logged by name from some package source file", () => {
    const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const sources = readdirSync(packages).flatMap((name) => {
      const src = join(packages, name, "src");
      if (!existsSync(src)) return [];
      return readdirSync(src, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFileSync(join(src, file), "utf8"));
    });
    const text = sources.join("\n");
    for (const name of SIGNALS) expect(text, name).toContain(`"${name}"`);
  });
});
