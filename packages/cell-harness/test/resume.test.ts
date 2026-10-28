// The person's resume of a stopped job: a new run forks the stopped run's conversation, so it
// holds every entry of the stopped run, then one resume line; its spend starts at zero and the
// job's cost counts every run (AC-30, harness half).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeJobTask } from "../src/job-task.ts";
import { conversationTotal } from "../src/month-ledger.ts";
import { stopJobs } from "../src/stop.ts";
import { addJobSpend, createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import { entriesOf, entryRole, entryText } from "./job-helpers.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

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
