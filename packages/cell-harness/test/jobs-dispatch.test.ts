// Jobs: a job task owns a fresh conversation, runs the brief there, and stores the answer on the
// board as a waiting result. The lead's tools that start and steer jobs are covered below.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPageDoc, JobBoardDoc } from "../src/docs.ts";
import { createJobRow } from "../src/job-board.ts";
import { createJobTask } from "../src/job-task.ts";
import { createFauxGateway, loggedEvents, openTestCell, type TestCell } from "./fixtures.ts";
import { JOB_BRIEF, jobResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("the job task", () => {
  it("a job task owns a fresh conversation and stores its answer as a waiting result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let opened: TestCell | undefined;
    const JobTask = createJobTask({
      person: "owner",
      gate: () => undefined,
      timeZone: "UTC",
      extensions: () => opened?.cell.extensions.specialist ?? [],
    });
    test = await openTestCell({
      gateway: createFauxGateway(jobResponder),
      extensions: [defineExtension({ name: "test-jobs", tasks: [JobTask] })],
    });
    opened = test;
    const { harness } = test.cell;
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
    await harness.waitForTask(taskId as TaskId<null>, BACKGROUND_CONTEXT);

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
