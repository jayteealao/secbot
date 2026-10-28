// The person's resume of a stopped job: a new run forks the stopped run's conversation, so it
// holds every entry of the stopped run, then one resume line; its spend starts at zero and the
// job's cost counts every run (AC-30, harness half).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionModels } from "../src/decision-model.ts";
import { resumeJobTask } from "../src/job-task.ts";
import { conversationTotal } from "../src/month-ledger.ts";
import { stopJobs } from "../src/stop.ts";
import { failingResearch, leadCalls, startPausedJob } from "./escalation-helpers.ts";
import {
  addJobSpend,
  createFauxGateway,
  fauxAssistantMessage,
  fauxToolCall,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { FIXTURE_PAGES, standInDecide } from "./injection-fixtures.ts";
import { entriesOf, entryRole, entryText } from "./job-helpers.ts";
import { createHold, jobResponder, RESEARCH_JOB, startJobLine } from "./responders.ts";
import { type StubOpenRouter, startStubOpenRouter } from "./stub-openrouter.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const job = async (t: TestCell, n = 1) => (await t.cell.board()).jobs[String(n)];

/** A cell with job 1 stopped by the person while its first step was in flight. */
export async function stoppedJob(): Promise<TestCell> {
  const hold = createHold();
  test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
  const t = test;
  hold.hold("research");
  await (
    await t.cell.submit(
      startJobLine({ title: "flights", brief: "find flights", template: "research" }),
      "start",
    )
  ).wait(BACKGROUND_CONTEXT);
  await until(() => hold.waiting("research") === 1);
  const stopping = stopJobs(
    { harness: t.cell.harness, root: t.cell.root, person: t.cell.person, now: t.cell.now },
    "person",
    BACKGROUND_CONTEXT,
  );
  await until(async () => (await job(t))?.stop !== null);
  hold.release("research");
  await stopping;
  return t;
}

describe("the resumed run", () => {
  it("forks the stopped run's transcript, then gets one resume line, and finishes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await stoppedJob();
    const stopped = await job(t);
    expect(stopped?.status).toBe("stopped");
    const oldConversation = stopped?.conversationId;
    if (oldConversation === null || oldConversation === undefined) throw new Error("no run");
    await addJobSpend(t.cell, 1, 0.3);
    const old = await t.cell.harness.conversation(oldConversation, BACKGROUND_CONTEXT);
    if (old === undefined) throw new Error("no old conversation");
    const oldEntries = (await entriesOf(old)).map((entry) => String(entry.id));
    expect(oldEntries.length).toBeGreaterThan(0);

    const task = t.cell.tasks?.job;
    if (task === undefined) throw new Error("no job task");
    const resumed = await t.cell.harness.commit(
      (tx) => resumeJobTask(tx, task, 1, t.cell.now(), "person"),
      BACKGROUND_CONTEXT,
    );
    expect("ok" in resumed).toBe(true);
    await until(async () => (await job(t))?.status === "done");
    const row = await job(t);
    expect(row).toMatchObject({
      status: "done",
      resumes: 1,
      attempts: { raises: 0, restarts: 0 },
      result: { kind: "routine", text: "research finding: evidence is mixed." },
    });
    const id = row?.conversationId;
    if (id === null || id === undefined) throw new Error("no new conversation");
    expect(String(id)).not.toBe(String(oldConversation));
    const fork = await t.cell.harness.conversation(id, BACKGROUND_CONTEXT);
    if (fork === undefined) throw new Error("no fork");
    const entries = await entriesOf(fork);
    // Every entry of the stopped run, in order, then the resume line and the answer.
    expect(entries.slice(0, oldEntries.length).map((entry) => String(entry.id))).toEqual(
      oldEntries,
    );
    const added = entries.slice(oldEntries.length);
    expect(entryRole(added[0] as never)).toBe("user");
    expect(entryText(added[0] as never)).toMatch(
      /^The person stopped this job at \d\d:\d\d; it is resumed now\. Continue the brief from where you stopped; your earlier messages are above\.$/,
    );
    expect(entries.filter((entry) => entryText(entry) === "find flights")).toHaveLength(1);
    // The fork's own spend starts empty; the job's cost is the sum over every run.
    const usage = await t.cell.harness.snapshot(UsageDoc, id, BACKGROUND_CONTEXT);
    expect(usage === undefined ? 0 : conversationTotal(usage)).toBe(0);
    expect(row?.cost).toBeCloseTo(0.3, 6);
  });
});

describe("the person's restart of a stopped job (AC-30)", () => {
  it("resumes with its kept brief, board entry, and transcript, without using its restart", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await stoppedJob();
    const before = await job(t);
    expect(await t.cell.resumeJob(1)).toEqual({ ok: true, job: 1, title: "flights" });
    await until(async () => (await job(t))?.status === "done");
    const after = await job(t);
    expect(after).toMatchObject({
      number: 1,
      title: before?.title,
      brief: "find flights",
      template: before?.template,
      tier: before?.tier,
      attempts: { raises: 0, restarts: 0 },
      resumes: 1,
      runs: [
        {
          conversationId: before?.conversationId,
          note: "stopped by the person; resumed by the person",
        },
      ],
    });
    // A done job does not resume again.
    expect(await t.cell.resumeJob(1)).toEqual({ ok: false, reason: "not-stopped" });
  });

  it("refuses a paused job and a missing number", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(failingResearch) });
    const t = test;
    await startPausedJob(t);
    expect(await t.cell.resumeJob(1)).toEqual({ ok: false, reason: "paused" });
    expect(await t.cell.resumeJob(22)).toEqual({ ok: false, reason: "no-job" });
    expect((await job(t))?.status).toBe("paused");
  });

  it("lets the lead resume it on the person's ask, with its own refusals", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await stoppedJob();
    expect(await leadCalls(t, "resume_job", { job: 22 })).toBe("No job 22 on the board.");
    expect(await leadCalls(t, "resume_job", { job: 1 })).toBe(
      "job 1 resumes from its kept brief and transcript; this does not use its restart.",
    );
    await until(async () => (await job(t))?.status === "done");
    expect((await job(t))?.runs.at(-1)?.note).toBe("stopped by the person; resumed by the lead");
    expect(await leadCalls(t, "resume_job", { job: 1 })).toBe(
      "job 1 is done; only a stopped or blocked job resumes.",
    );
  });
});

describe("the person's restart of a blocked job", () => {
  let stub: StubOpenRouter;
  beforeEach(async () => {
    stub = await startStubOpenRouter();
    stub.decide = standInDecide;
  });
  afterEach(async () => {
    await stub.close();
  });

  it("reads the injected page again, is checked again, and is blocked again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    test = await openTestCell({
      gateway: createFauxGateway((request) =>
        request.role === "research" && request.last?.role !== "toolResult"
          ? fauxAssistantMessage([fauxToolCall("read_fixture_page", { page: "injected" })], {
              stopReason: "toolUse",
            })
          : jobResponder(request),
      ),
      fixturePages: FIXTURE_PAGES,
      guard: {
        decision: createDecisionModels({ apiKey: "decisions-test-key-0000", baseUrl: stub.origin }), // gitleaks:allow (fake test key)
      },
    });
    const t = test;
    await (await t.cell.submit(RESEARCH_JOB, "read-injected")).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.status === "blocked");
    const firstChecks = stub.seen.length;
    expect(await t.cell.resumeJob(1)).toEqual({ ok: true, job: 1, title: expect.any(String) });
    await until(async () => (await job(t))?.status === "blocked" && (await job(t))?.resumes === 1);
    expect(stub.seen.length).toBeGreaterThan(firstChecks);
    expect(await job(t)).toMatchObject({
      status: "blocked",
      block: { cause: "hit", kind: "page" },
      attempts: { raises: 0, restarts: 0 },
      runs: [{ note: "blocked; resumed by the person" }],
    });
  });
});
