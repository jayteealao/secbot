// Relay mode: the household agent has no lead, so its job and review tasks store the result and
// end with no wake notice; a risky result is still reviewed. The household's job tools leave out
// the tools that ask a lead.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  type Extension,
  Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { openCelldStorageWithDatabase } from "@secbot/cell-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc, type JobRow } from "../src/docs.ts";
import { createHouseholdExtension } from "../src/household-tools.ts";
import { createJobRow } from "../src/job-board.ts";
import { JobHolds } from "../src/job-holds.ts";
import { createJobTask } from "../src/job-task.ts";
import { createJobToolsExtension } from "../src/job-tools.ts";
import { HOUSEHOLD_AGENT_TOOLS } from "../src/release-defaults.ts";
import { createReviewTask } from "../src/result-review.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  FakeCelldStorage,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
  resultReviewer,
  until,
} from "./fixtures.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close(BACKGROUND_CONTEXT);
  harness = undefined;
  vi.restoreAllMocks();
});

const plans: Responder = (request) =>
  fauxAssistantMessage([fauxText(`${request.role} plan for both: ${request.lastText}`)]);

async function openRelay(
  respond: Responder = plans,
  extensions: (harness: () => Harness) => readonly Extension[] = () => [],
) {
  const gateway = createFauxGateway(resultReviewer(respond));
  let current: Harness | undefined;
  const own = () => {
    if (current === undefined) throw new Error("not open");
    return current;
  };
  const installed = extensions(own);
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
    extensions: () => installed,
    relay: true,
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "relay-test", tasks: [JobTask, ReviewTask] }));
  for (const extension of installed) registry.install(extension);
  const durable = await openCelldStorageWithDatabase(new FakeCelldStorage());
  const opened = await Harness.open(
    durable.storage,
    { models: gateway.models, registry, now: () => Date.now() },
    BACKGROUND_CONTEXT,
  );
  harness = opened;
  current = opened;
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

describe("the household agent's job tools", () => {
  const household = createHouseholdStub();
  const tools = (harness: () => Harness) => [
    createHouseholdExtension("household", () => household),
    createJobToolsExtension({
      person: "household",
      harness,
      holds: new JobHolds(),
      now: () => Date.now(),
      wrapped: [...HOUSEHOLD_AGENT_TOOLS],
      household: true,
    }),
  ];
  const addsMilk: Responder = (request) =>
    request.last?.role === "toolResult"
      ? fauxAssistantMessage([fauxText("Added milk to the list for both of you.")])
      : fauxAssistantMessage([fauxToolCall("household_change", { op: "add", text: "milk" })], {
          stopReason: "toolUse",
        });

  it("lists exactly the two household tools and the old-attempt search", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await openRelay(addsMilk, tools);
    const n = await t.start("household", "the shopping");
    await until(async () => (await t.row(n))?.conversationId != null);
    const id = (await t.row(n))?.conversationId;
    if (id === null || id === undefined) throw new Error("no job conversation");
    const agent = await (await t.harness.conversation(id, BACKGROUND_CONTEXT))?.agent(
      BACKGROUND_CONTEXT,
    );
    expect(agent?.tools.map((tool) => tool.name).sort()).toEqual([
      "household_change",
      "household_read",
      "search_old_job",
    ]);
  });

  it("marks a result risky after a household change, and reviews it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await openRelay(addsMilk, tools);
    const n = await t.start("household", "the shopping");
    await until(async () => (await t.row(n))?.review?.status === "passed");
    const row = await t.row(n);
    expect(row?.toolsUsed).toEqual(["household_change"]);
    expect(row?.risky.code).toEqual(["household_change acts"]);
    expect(row?.result).toMatchObject({ kind: "risky", wokeAt: null });
    expect(household.changes.at(-1)).toMatchObject({ kind: "add", text: "milk" });
  });
});
