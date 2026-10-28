// Each role's resolved tool list. The lead starts and reads jobs (the only routing path), reads
// background results, keeps its bookmark, searches history, reads and changes household documents,
// uses the two secrets tools, and sets reminders, which only schedule a message to the lead
// itself. A job's conversation holds history, household, and secrets tools only: no tool starts
// other agents. No built-in pi-durable tool (read, write, edit, bash) is installed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

const LEAD_TOOLS = [
  "answer_job",
  "ask_person",
  "broker_call",
  "household_change",
  "household_read",
  "job_result",
  "job_transcript",
  "mark_risky",
  "note_bookmark",
  "read_job",
  "read_result",
  "restart_job",
  "resume_work",
  "search_history",
  "secret_get",
  "set_job",
  "set_reminder",
  "start_job",
];
const JOB_TOOLS = [
  "ask_lead",
  "broker_call",
  "household_change",
  "household_read",
  "search_history",
  "search_old_job",
  "secret_get",
];

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

/** Starts one research job held at the model and returns its conversation's resolved agent. */
async function heldJobAgent(t: TestCell, hold: ReturnType<typeof createHold>) {
  await (
    await t.cell.submit(startJobLine({ title: "a", brief: "look", template: "research" }), "r-1")
  ).wait(BACKGROUND_CONTEXT);
  await until(() => hold.waiting("research") === 1);
  const id = (await t.cell.board()).jobs["1"]?.conversationId;
  if (id === null || id === undefined) throw new Error("no job conversation");
  const conversation = await t.cell.harness.conversation(id, BACKGROUND_CONTEXT);
  return conversation?.agent(BACKGROUND_CONTEXT);
}

describe("tool lists", () => {
  it("gives the lead the job, result, bookmark, history, household, secrets, and reminder tools, and a job history, household, and secrets only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.tools.map((tool) => tool.name).sort()).toEqual(LEAD_TOOLS);
    const installed = test.cell.extensions.lead.flatMap((extension) => extension.tools ?? []);
    expect(installed.map((tool) => tool.name).sort()).toEqual(LEAD_TOOLS);
    const job = await heldJobAgent(test, hold);
    expect(job?.tools.map((tool) => tool.name).sort()).toEqual(JOB_TOOLS);
    hold.release("research");
  });

  it("puts the guard first in the lead's list and in every job's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    expect(test.cell.extensions.lead[0]?.name).toBe("secbot-guard");
    expect(test.cell.extensions.job[0]?.name).toBe("secbot-guard");
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.extensions[0]?.name).toBe("secbot-guard");
    expect((await heldJobAgent(test, hold))?.extensions[0]?.name).toBe("secbot-guard");
    hold.release("research");
  });

  it("puts the budget check right after the guard on every job's list, never the lead's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = createHold();
    hold.hold("research");
    test = await openTestCell({ gateway: createFauxGateway(hold.wrap(jobResponder)) });
    expect(test.cell.extensions.job[1]?.name).toBe("secbot-budget");
    expect(test.cell.extensions.lead.map((extension) => extension.name)).not.toContain(
      "secbot-budget",
    );
    const lead = await test.cell.root.agent(BACKGROUND_CONTEXT);
    expect(lead.extensions.map((extension) => extension.name)).not.toContain("secbot-budget");
    const job = await heldJobAgent(test, hold);
    expect(job?.extensions.slice(0, 2).map((extension) => extension.name)).toEqual([
      "secbot-guard",
      "secbot-budget",
    ]);
    hold.release("research");
  });
});
