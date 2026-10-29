// Relay mode: the household agent has no lead, so its job and review tasks store the result and
// end with no wake notice; a risky result is still reviewed. The household's job tools leave out
// the tools that ask a lead.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { openCelldStorageWithDatabase } from "@secbot/cell-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc, type JobRow } from "../src/docs.ts";
import { createJobRow } from "../src/job-board.ts";
import { createJobTask } from "../src/job-task.ts";
import { createReviewTask } from "../src/result-review.ts";
import {
  createFauxGateway,
  FakeCelldStorage,
  fauxAssistantMessage,
  fauxText,
  resultReviewer,
  until,
} from "./fixtures.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close(BACKGROUND_CONTEXT);
  harness = undefined;
  vi.restoreAllMocks();
});

async function openRelay() {
  const gateway = createFauxGateway(
    resultReviewer((request) =>
      fauxAssistantMessage([fauxText(`${request.role} plan for both: ${request.lastText}`)]),
    ),
  );
  const ReviewTask = createReviewTask({
    person: "household",
    now: () => Date.now(),
    extensions: () => [],
    relay: true,
  });
  const JobTask = createJobTask({
    person: "household",
    review: () => ReviewTask,
    gate: () => undefined,
    timeZone: "UTC",
    extensions: () => [],
    relay: true,
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "relay-test", tasks: [JobTask, ReviewTask] }));
  const durable = await openCelldStorageWithDatabase(new FakeCelldStorage());
  const opened = await Harness.open(
    durable.storage,
    { models: gateway.models, registry, now: () => Date.now() },
    BACKGROUND_CONTEXT,
  );
  harness = opened;
  await opened.root(BACKGROUND_CONTEXT);
  opened.resume();
  const start = (template: string, title: string) =>
    opened.commit(async (tx) => {
      const row = await createJobRow(tx, {
        title,
        brief: `Plan ${title} for both people.`,
        priority: "routine",
        deadline: null,
        template,
        tier: "cheap",
        effort: { requested: "medium", applied: "medium" },
        owner: "shared",
        turn: null,
        createdAt: Date.now(),
      });
      row.taskId = await tx.createTask(
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
  const row = async (n: number): Promise<JobRow | undefined> =>
    (await opened.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs[String(n)];
  return { harness: opened, gateway, start, row };
}

describe("relay mode of the job and review tasks", () => {
  it("stores a routine and a reviewed risky result, and never writes to the root conversation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await openRelay();
    const routine = await t.start("household", "the May trip");
    const risky = await t.start("health", "the meal plan");
    await until(async () => (await t.row(routine))?.status === "done");
    await until(async () => (await t.row(risky))?.review?.status === "passed");
    expect((await t.row(routine))?.result).toMatchObject({ kind: "routine", wokeAt: null });
    expect((await t.row(risky))?.result).toMatchObject({ kind: "risky", wokeAt: null });
    const root = await t.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    const entries = await root?.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    expect(entries?.items ?? []).toEqual([]);
    const settled = await t.harness.inspect(BACKGROUND_CONTEXT);
    expect(JSON.stringify(settled)).not.toContain('"phase":"await"');
    expect(JSON.stringify(settled)).not.toContain('"phase":"notify"');
  });
});
