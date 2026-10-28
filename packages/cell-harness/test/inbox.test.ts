// The results inbox: a routine result waits on the board with nothing in the lead's conversation;
// a failure, a question, or a risky result sends one wake notice without the result; a routine
// result unpulled for 30 minutes sends one too, across a restart.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc, type ResultKind } from "../src/docs.ts";
import { createJobRow, pullResult, storeResult, waitingCounts } from "../src/job-board.ts";
import { createJobTask } from "../src/job-task.ts";
import { RESULT_WAKE_MS } from "../src/release-defaults.ts";
import { wakesOf } from "../src/wake-times.ts";
import {
  createFauxGateway,
  type FakeCelldStorage,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { JOB_BRIEF, jobResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const textOf = (entry: EntryRecord): string => {
  const message = entry.model?.[0] as Message | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

async function leadEntries(t: TestCell): Promise<EntryRecord[]> {
  const page = await t.cell.root.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  return [...page.items].reverse();
}

const wakeNotices = async (t: TestCell) =>
  (await leadEntries(t))
    .filter((entry) => entry.kind === "pi.user")
    .map(textOf)
    .filter((text) => text.startsWith("[job "));

/** A cell whose test extension registers the job task (the lead's tools come later). */
async function openJobCell(options: {
  readonly respond?: Responder;
  readonly now?: () => number;
  readonly storage?: FakeCelldStorage;
}): Promise<{ t: TestCell; JobTask: ReturnType<typeof createJobTask> }> {
  let opened: TestCell | undefined;
  const JobTask = createJobTask({
    person: "owner",
    gate: () => undefined,
    timeZone: "UTC",
    extensions: () => opened?.cell.extensions.specialist ?? [],
  });
  opened = await openTestCell({
    gateway: createFauxGateway(options.respond ?? jobResponder),
    extensions: [defineExtension({ name: "test-jobs", tasks: [JobTask] })],
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });
  return { t: opened, JobTask };
}

/** Starts job `n` (with an optional result stored ahead, as later producers will) and its task. */
async function startJob(
  t: TestCell,
  JobTask: ReturnType<typeof createJobTask>,
  stored?: { readonly kind: ResultKind; readonly text: string },
): Promise<{ number: number; taskId: TaskId<null> }> {
  return t.cell.harness.commit(async (tx) => {
    const row = await createJobRow(tx, {
      title: "a job",
      brief: JOB_BRIEF,
      priority: "routine",
      deadline: null,
      template: "research",
      tier: "mid",
      effort: { requested: "medium", applied: "medium" },
      owner: "owner",
      turn: null,
      createdAt: t.cell.now(),
    });
    if (stored !== undefined) await storeResult(tx, row.number, stored.kind, stored.text, 1);
    const taskId = await tx.createTask(
      JobTask,
      { number: row.number },
      {
        ownership: { kind: "conversation" },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      },
    );
    return { number: row.number, taskId: taskId as TaskId<null> };
  }, BACKGROUND_CONTEXT);
}

const boardOf = async (t: TestCell) => {
  const board = await t.cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT);
  if (board === undefined) throw new Error("no board");
  return board;
};

describe("the results inbox", () => {
  it("keeps a routine result on the board and out of the lead until it is pulled (AC-10)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { t, JobTask } = await openJobCell({});
    test = t;
    await startJob(t, JobTask);
    await until(async () => (await boardOf(t)).jobs["1"]?.result !== null);
    expect(waitingCounts(await boardOf(t))).toEqual({
      failure: 0,
      question: 0,
      risky: 0,
      routine: 1,
    });
    expect(await leadEntries(t)).toHaveLength(0);
    const pulled = await t.cell.harness.commit(
      (tx) => pullResult(tx, 1, t.cell.now()),
      BACKGROUND_CONTEXT,
    );
    expect(pulled?.text).toBe("research finding: evidence is mixed.");
    expect(waitingCounts(await boardOf(t)).routine).toBe(0);
  });

  it("sends one wake notice for a failure, without the result (AC-11)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { t, JobTask } = await openJobCell({
      respond: (request) =>
        request.role === "research" ? fauxAssistantMessage([fauxText("")]) : jobResponder(request),
    });
    test = t;
    const { taskId } = await startJob(t, JobTask);
    await t.cell.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    await until(async () => (await wakeNotices(t)).length > 0);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await wakeNotices(t)).toEqual(["[job 1 failure: pull it with job_result]"]);
    const job = (await boardOf(t)).jobs["1"];
    expect(job).toMatchObject({ status: "failed", result: { kind: "failure" } });
    expect(job?.result?.wokeAt).not.toBeNull();
  });

  it("sends one wake notice for a question and for a risky result, without the result (AC-11)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { t, JobTask } = await openJobCell({});
    test = t;
    const question = await startJob(t, JobTask, {
      kind: "question",
      text: "Which airport, LIS or OPO?",
    });
    const risky = await startJob(t, JobTask, {
      kind: "risky",
      text: "Booked the flight for £412.",
    });
    await t.cell.harness.waitForTask(question.taskId, BACKGROUND_CONTEXT);
    await t.cell.harness.waitForTask(risky.taskId, BACKGROUND_CONTEXT);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    const notices = await wakeNotices(t);
    expect(notices.sort()).toEqual([
      "[job 1 question: pull it with job_result]",
      "[job 2 risky: pull it with job_result]",
    ]);
    const lead = JSON.stringify(await leadEntries(t));
    expect(lead).not.toContain("LIS or OPO");
    expect(lead).not.toContain("412");
  });

  it("sends one wake notice for a routine result unpulled for 30 minutes, across a restart (AC-12)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 9, 28, 9, 0);
    const now = () => clock;
    const { t, JobTask } = await openJobCell({ now });
    test = t;
    await startJob(t, JobTask);
    await until(async () => (await boardOf(t)).jobs["1"]?.result !== null);
    // The task waits for the 30-minute mark, and the cell's alarm knows it.
    await until(async () => {
      const wakes = wakesOf(await t.cell.harness.inspect(BACKGROUND_CONTEXT)).wakes;
      return wakes.some((wake) => wake.kind === "job");
    });
    const at = (await boardOf(t)).jobs["1"]?.result?.at ?? 0;
    const wake = wakesOf(await t.cell.harness.inspect(BACKGROUND_CONTEXT)).wakes.find(
      (each) => each.kind === "job",
    );
    expect(wake?.at).toBe(at + RESULT_WAKE_MS);
    expect(await wakeNotices(t)).toEqual([]);

    await t.cell.close();
    clock += RESULT_WAKE_MS;
    await t.reopen();
    await until(async () => (await wakeNotices(t)).length > 0);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await wakeNotices(t)).toEqual(["[job 1 waited 30 minutes: pull it with job_result]"]);
    expect((await boardOf(t)).jobs["1"]?.result?.wokeAt).toBe(clock);

    // Another restart sends nothing again.
    await t.reopen();
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await wakeNotices(t)).toHaveLength(1);
  });

  it("sends no late notice for a routine result pulled in time (AC-12)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 9, 28, 9, 0);
    const { t, JobTask } = await openJobCell({ now: () => clock });
    test = t;
    const { taskId } = await startJob(t, JobTask);
    await until(async () => (await boardOf(t)).jobs["1"]?.result !== null);
    await t.cell.harness.commit((tx) => pullResult(tx, 1, clock), BACKGROUND_CONTEXT);
    await t.cell.close();
    clock += RESULT_WAKE_MS;
    await t.reopen();
    await t.cell.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await wakeNotices(t)).toEqual([]);
  });
});
