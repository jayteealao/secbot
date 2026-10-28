// Questions and requests: a job asks the lead with ask_lead and waits with no spend; the lead
// answers from what it knows or asks the person (AC-21, AC-22); a job cannot start a subagent and
// asks the lead for a new job instead (AC-23).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion } from "../src/job-board.ts";
import { questionNotice } from "../src/job-tools.ts";
import { job } from "./escalation-helpers.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  loggedEvents,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { wakeNoticesOf } from "./job-helpers.ts";
import { jobResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const QUESTION = "Which airport should I search from?";

/** A research job that asks the lead one question, then answers with what it was told. */
export const asksLead: Responder = (request) => {
  if (request.role !== "research") return jobResponder(request);
  if (request.last?.role === "toolResult") {
    return fauxAssistantMessage([fauxText(`Searched with: ${request.lastText}`)]);
  }
  return fauxAssistantMessage([fauxToolCall("ask_lead", { question: QUESTION })], {
    stopReason: "toolUse",
  });
};

export const researchRequests = (t: TestCell) =>
  t.gateway.requests.filter((request) => request.role === "research").length;

export async function startAskingJob(t: TestCell): Promise<void> {
  await (
    await t.cell.submit(
      startJobLine({ title: "flights", brief: "find flights to Lisbon", template: "research" }),
      "ask-1",
    )
  ).wait(BACKGROUND_CONTEXT);
  await until(async () => (await job(t))?.status === "waiting");
}

describe("the job's question tool", () => {
  it("waits with no request until answered, and the answer is the tool's result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(asksLead) });
    const t = test;
    await startAskingJob(t);
    expect((await job(t))?.question).toMatchObject({
      number: 1,
      from: "job",
      text: QUESTION,
      toPerson: false,
      answer: null,
    });
    await until(async () => (await wakeNoticesOf(t.cell.root)).includes(questionNotice(1)));
    const asked = researchRequests(t);
    expect(t.cell.holds.waiting(1)).toBe(1);

    await t.cell.harness.commit(
      (tx) => answerQuestion(tx, 1, "Lisbon from London only.", "lead", Date.now()),
      BACKGROUND_CONTEXT,
    );
    expect((await job(t))?.status).toBe("running");
    t.cell.holds.wake(1);
    await until(async () => (await job(t))?.result != null);

    expect(researchRequests(t)).toBe(asked + 1);
    const next = t.gateway.requests.filter((request) => request.role === "research").at(-1);
    expect(next?.lastText).toBe("The lead answers: Lisbon from London only.");
    expect((await job(t))?.result?.text).toBe(
      "Searched with: The lead answers: Lisbon from London only.",
    );
    const events = loggedEvents(log.mock.calls).filter(
      (each) => each.event === "job.question_asked",
    );
    expect(events).toEqual([
      expect.objectContaining({ job: 1, to_person: false, question_chars: QUESTION.length }),
    ]);
    expect(JSON.stringify(events)).not.toContain("airport");
  });
});
