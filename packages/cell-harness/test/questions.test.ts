// Questions and requests: a job asks the lead with ask_lead and waits with no spend; the lead
// answers from what it knows or asks the person (AC-21, AC-22); a job cannot start a subagent and
// asks the lead for a new job instead (AC-23).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion } from "../src/job-board.ts";
import {
  questionNotice,
  REQUESTS_PER_JOB_MAX,
  requestNotice,
  requestsPerJobText,
} from "../src/job-tools.ts";
import { askPersonText } from "../src/lead-texts.ts";
import { job, leadCalls } from "./escalation-helpers.ts";
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

/** A faux lead that answers a job's question from its history; every other request as `others`. */
const leadFindsAnswer =
  (others: Responder): Responder =>
  (request) => {
    if (request.role === "lead" && request.lastText === questionNotice(1)) {
      return fauxAssistantMessage([fauxToolCall("search_history", { query: "Heathrow" })], {
        stopReason: "toolUse",
      });
    }
    if (
      request.role === "lead" &&
      request.last?.role === "toolResult" &&
      request.lastText.includes("always fly from Heathrow")
    ) {
      return fauxAssistantMessage(
        [
          fauxToolCall("answer_job", {
            job: 1,
            answer: "Heathrow; the person always flies from there.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return others(request);
  };

describe("the lead answers, or asks the person", () => {
  it("answers from its history without asking the person, and the job goes on (AC-21)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell({ gateway: createFauxGateway(leadFindsAnswer(asksLead)) });
    const t = test;
    await (await t.cell.submit("I always fly from Heathrow airport.", "said-1")).wait(
      BACKGROUND_CONTEXT,
    );
    await startAskingJob(t);
    await until(async () => (await job(t))?.status === "done");
    const row = await job(t);
    expect(row?.question).toMatchObject({
      answeredBy: "lead",
      toPerson: false,
      personAskedAt: null,
      answer: "Heathrow; the person always flies from there.",
    });
    expect(row?.result?.text).toBe(
      "Searched with: The lead answers: Heathrow; the person always flies from there.",
    );
    expect(await t.cell.openQuestions()).toEqual([]);
    expect(
      t.gateway.requests.some(
        (request) => request.role === "lead" && request.lastText.includes("Ask the person"),
      ),
    ).toBe(false);
  });

  it("asks the person for a question that commits them; the job waits a week across a reopen, then the person's answer continues it (AC-22)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.now();
    const leadAsksPerson: Responder = (request) => {
      if (request.role === "lead" && request.lastText === questionNotice(1)) {
        return fauxAssistantMessage([fauxToolCall("ask_person", { job: 1 })], {
          stopReason: "toolUse",
        });
      }
      if (request.role === "lead" && request.lastText === askPersonText(1)) {
        return fauxAssistantMessage([
          fauxText(
            "The passport job needs one fact from you: which address goes on the form, home or the office?",
          ),
        ]);
      }
      return asksLead(request);
    };
    test = await openTestCell({ gateway: createFauxGateway(leadAsksPerson), now: () => clock });
    const t = test;
    await startAskingJob(t);
    await until(async () => (await job(t))?.question?.toPerson === true);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await t.cell.openQuestions()).toEqual([
      expect.objectContaining({ job: 1, title: "flights", question: QUESTION }),
    ]);
    const asked = researchRequests(t);

    clock += 7 * 24 * 60 * 60 * 1000;
    await t.reopen();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await job(t))?.status).toBe("waiting");
    expect(researchRequests(t)).toBe(asked);
    expect(await t.cell.openQuestions()).toHaveLength(1);

    expect(await t.cell.answerJob(1, "home address")).toEqual({
      ok: true,
      job: 1,
      title: "flights",
    });
    await until(async () => (await job(t))?.status === "done");
    expect((await job(t))?.result?.text).toBe("Searched with: The person answers: home address");
    expect(await t.cell.answerJob(1, "again")).toMatchObject({
      ok: false,
      reason: "no-question",
      message: "job 1 has no question waiting",
    });
    expect(await t.cell.answerJob(9, "x")).toMatchObject({ ok: false, message: "no job #9" });
  });
});

describe("no spawn: a job asks for a new job (AC-23)", () => {
  it("gives a job no tool that starts work; request_job adds a row only the lead starts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Responder = (request) => {
      if (request.role !== "research") return jobResponder(request);
      if (request.lastText.includes("find hotels near the venue")) {
        return fauxAssistantMessage([fauxText("Hotels: three near the venue.")]);
      }
      if (request.last?.role === "toolResult") {
        return fauxAssistantMessage([fauxText("Flights found; hotels asked for.")]);
      }
      return fauxAssistantMessage(
        [
          fauxToolCall("request_job", {
            title: "hotels",
            brief: "find hotels near the venue",
            template: "research",
          }),
        ],
        { stopReason: "toolUse" },
      );
    };
    test = await openTestCell({ gateway: createFauxGateway(requests) });
    const t = test;
    await (
      await t.cell.submit(
        startJobLine({ title: "flights", brief: "find flights to Lisbon", template: "research" }),
        "req-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.result != null);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);

    const id = (await job(t))?.conversationId;
    if (id === null || id === undefined) throw new Error("no job conversation");
    const agent = await (await t.cell.harness.conversation(id, BACKGROUND_CONTEXT))?.agent(
      BACKGROUND_CONTEXT,
    );
    const names = agent?.tools.map((tool) => tool.name) ?? [];
    for (const name of ["start_job", "restart_job", "set_job", "answer_job"]) {
      expect(names).not.toContain(name);
    }

    const requested = await job(t, 2);
    expect(requested).toMatchObject({
      status: "queued",
      requestedBy: 1,
      taskId: null,
      conversationId: null,
      title: "hotels",
    });
    expect(await wakeNoticesOf(t.cell.root)).toContain(requestNotice(1, 2));
    expect(
      loggedEvents(log.mock.calls).find((each) => each.event === "job.requested"),
    ).toMatchObject({ job: 2, by_job: 1 });

    const said = await leadCalls(t, "start_job", { request: 2 });
    expect(said).toContain("job 2 started: research");
    await until(async () => (await job(t, 2))?.result != null);
    expect((await job(t, 2))?.result?.text).toBe("Hotels: three near the venue.");
    expect(await leadCalls(t, "start_job", { request: 2 })).toBe(
      "job 2 is not a requested job waiting to start.",
    );
  });

  it("refuses a job's request once it has three waiting for the lead", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let asked = 0;
    let refused = "";
    const requests: Responder = (request) => {
      if (request.role !== "research") return jobResponder(request);
      if (asked > REQUESTS_PER_JOB_MAX) {
        refused = request.lastText;
        return fauxAssistantMessage([fauxText("Done asking.")]);
      }
      asked++;
      return fauxAssistantMessage(
        [
          fauxToolCall("request_job", {
            title: `part ${asked}`,
            brief: `part ${asked} of the work`,
            template: "research",
          }),
        ],
        { stopReason: "toolUse" },
      );
    };
    test = await openTestCell({ gateway: createFauxGateway(requests) });
    const t = test;
    await (
      await t.cell.submit(
        startJobLine({ title: "plan", brief: "plan the move", template: "research" }),
        "req-2",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.result != null);
    await t.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(refused).toContain(requestsPerJobText(REQUESTS_PER_JOB_MAX));
    for (let m = 2; m <= REQUESTS_PER_JOB_MAX + 1; m++) {
      expect((await job(t, m))?.requestedBy).toBe(1);
    }
    expect(await job(t, REQUESTS_PER_JOB_MAX + 2)).toBeUndefined();
  });
});
