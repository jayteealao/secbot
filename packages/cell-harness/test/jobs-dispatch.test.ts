// Jobs: a job task owns a fresh conversation, runs the brief there, and stores the answer on the
// board as a waiting result. The lead's tools that start and steer jobs are covered below.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPageDoc, JobBoardDoc } from "../src/docs.ts";
import { createJobRow } from "../src/job-board.ts";
import {
  createFauxGateway,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { answersOf, toolResultsOf } from "./job-helpers.ts";
import { createHold, JOB_BRIEF, jobResponder, RESEARCH_JOB, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("the job task", () => {
  it("a job task owns a fresh conversation and stores its answer as a waiting result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    const { harness } = test.cell;
    const JobTask = test.cell.tasks?.job;
    if (JobTask === undefined) throw new Error("no job task");
    const taskId = await harness.commit(async (tx) => {
      const row = await createJobRow(tx, {
        title: "flights to Lisbon",
        brief: JOB_BRIEF,
        priority: "routine",
        deadline: null,
        template: "research",
        tier: "mid",
        effort: { requested: "high", applied: "high" },
        owner: "owner",
        turn: null,
        createdAt: 1_000,
      });
      return tx.createTask(
        JobTask,
        { number: row.number },
        {
          ownership: { kind: "conversation" },
          conversationId: ROOT_CONVERSATION_ID,
          background: true,
        },
      );
    }, BACKGROUND_CONTEXT);
    // The task stays alive after the result, waiting for its 30-minute mark.
    await until(
      async () =>
        (await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"]?.result != null,
    );
    expect(
      (await harness.getTask(taskId as TaskId<null>, BACKGROUND_CONTEXT))?.state,
    ).toMatchObject({
      status: "running",
      checkpoint: { phase: "await" },
    });

    const board = await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT);
    const row = board?.jobs["1"];
    expect(row).toMatchObject({
      status: "done",
      taskId,
      result: { kind: "routine", text: "research finding: evidence is mixed.", pulledAt: null },
    });
    const conversationId = row?.conversationId;
    if (conversationId === null || conversationId === undefined) throw new Error("no conversation");
    expect(conversationId).not.toBe(ROOT_CONVERSATION_ID);
    expect(board?.byConversation[String(conversationId)]).toBe(1);

    // The job's own conversation: the brief, the mid tier's model, the applied effort.
    const research = test.gateway.requests.filter((request) => request.role === "research");
    expect(research.map((request) => request.lastText)).toEqual([JOB_BRIEF]);
    expect(research[0]?.modelId).toBe("anthropic/claude-sonnet-5.5");
    const job = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
    const agent = await job?.agent(BACKGROUND_CONTEXT);
    expect(agent?.thinkingLevel).toBe("high");
    expect(agent?.tools.map((tool) => tool.name)).not.toContain("start_job");

    // Nothing entered the lead's conversation.
    const lead = await test.cell.root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    expect(lead.items).toHaveLength(0);

    // One done record in activity, and the start and finish lines without the brief.
    const month = new Date().toISOString().slice(0, 7);
    const page = await harness.snapshot(ActivityPageDoc, `${month}:1`, BACKGROUND_CONTEXT);
    expect(page?.records.filter((record) => record.key === `job:${taskId}`)).toHaveLength(1);
    const events = loggedEvents(log.mock.calls);
    expect(events.find((event) => event.event === "job.started")).toMatchObject({
      job: 1,
      template: "research",
      tier: "mid",
      effort_applied: "high",
      brief_chars: JOB_BRIEF.length,
    });
    expect(events.find((event) => event.event === "job.finished")).toMatchObject({
      job: 1,
      outcome: "answered",
    });
    expect(JSON.stringify(events)).not.toContain(JOB_BRIEF);
  });
});

/** A cell whose faux lead follows `respond`. */
const openToolCell = (respond: Responder = jobResponder): Promise<TestCell> =>
  openTestCell({ gateway: createFauxGateway(respond) });

const answers = (t: TestCell) => answersOf(t.cell.root);
const toolResults = (t: TestCell) => toolResultsOf(t.cell.root);

describe("the lead's job tools", () => {
  it("starts a research job with every board field and answers with the one-line notice (AC-1)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openToolCell();
    const t = test;
    await (await t.cell.submit(`Find me flights\n${RESEARCH_JOB}`, "req-1")).wait(
      BACKGROUND_CONTEXT,
    );
    expect(await answers(t)).toEqual([
      "On it: comparing direct flights to Lisbon in May (job 1, research, mid)",
    ]);
    const row = (await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"];
    expect(row).toMatchObject({
      number: 1,
      title: "comparing direct flights to Lisbon in May",
      brief: JOB_BRIEF,
      priority: "routine",
      deadline: null,
      template: "research",
      tier: "mid",
      effort: { requested: "medium", applied: "medium" },
      attempts: { raises: 0, restarts: 0 },
      cap: 1,
      owner: "owner",
    });
    expect(typeof row?.cost).toBe("number");
    expect(["queued", "running", "done"]).toContain(row?.status);
    expect(row?.turn).not.toBeNull();
  });

  it("refuses an unknown template and an unknown job with the valid names", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openToolCell();
    const t = test;
    await (
      await t.cell.submit(
        `${startJobLine({ title: "x", brief: "y", template: "astrology" })}\nCALL read_job {"job":9}`,
        "req-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    const said = (await toolResults(t)).join("\n");
    expect(said).toContain(
      "No template named astrology. Templates: household, research, health, developer.",
    );
    expect(said).toContain("No job 9: the board has no jobs.");
    expect((await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.nextNumber ?? 1).toBe(
      1,
    );
  });

  it("lowers a research job to cheap and raises its effort, keeping both efforts (AC-5)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    test = await openToolCell(hold.wrap(jobResponder));
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "req-1")).wait(BACKGROUND_CONTEXT);
    await until(() => hold.waiting("research") === 1);
    await (
      await t.cell.submit('CALL set_job {"job":1,"tier":"cheap","effort":"low"}', "req-2")
    ).wait(BACKGROUND_CONTEXT);
    let row = (await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"];
    expect(row).toMatchObject({
      tier: "cheap",
      cap: 0.25,
      effort: { requested: "low", applied: "medium" },
    });
    const conversationId = row?.conversationId;
    if (conversationId === null || conversationId === undefined) throw new Error("no conversation");
    const agent = await (
      await t.cell.harness.conversation(conversationId, BACKGROUND_CONTEXT)
    )?.agent(BACKGROUND_CONTEXT);
    expect(agent?.model?.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(agent?.thinkingLevel).toBe("medium");

    await (await t.cell.submit('CALL set_job {"job":1,"effort":"high"}', "req-3")).wait(
      BACKGROUND_CONTEXT,
    );
    row = (await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"];
    expect(row).toMatchObject({ tier: "cheap", effort: { requested: "high", applied: "high" } });
    hold.release("research");
    await until(
      async () =>
        (await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"]?.result != null,
    );
  });

  it("pulls a result with job_result and reads a job with read_job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openToolCell();
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "req-1")).wait(BACKGROUND_CONTEXT);
    await until(
      async () =>
        (await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"]?.result != null,
    );
    await (await t.cell.submit('CALL job_result {"job":1}\nCALL read_job {"job":1}', "req-2")).wait(
      BACKGROUND_CONTEXT,
    );
    const toolTexts = (await toolResults(t)).join("\n");
    expect(toolTexts).toContain("research finding: evidence is mixed.");
    const row = (await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs["1"];
    expect(row?.result?.pulledAt).not.toBeNull();
  });
});
