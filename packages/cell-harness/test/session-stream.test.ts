// Local stand-in for the live session: the lead's answer streams in parts, and an answer the lead
// gives on a job's wake notice while the session is open is sent without a new request from the
// person; the delivered callback lets the cell advance the device's cursor.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc, type JobRow } from "../src/docs.ts";
import { createSharedRow } from "../src/job-board.ts";
import { questionNotice } from "../src/job-tools.ts";
import { askPersonText } from "../src/lead-texts.ts";
import { type Frame, personOffers } from "../src/session-stream.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  openTestCell,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { jobResponder, researchResponder, startJobLine } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("session frames", () => {
  it("streams the answer in parts, then sends the lead's answer to a wake notice with no new request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The research job's request is refused for good, so it does not answer (an empty reply
    // alone now pauses a job instead): a failed job wakes the lead at once.
    const gateway = createFauxGateway(
      (request) =>
        request.role === "research"
          ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Bad request" })
          : researchResponder(request),
      { tokensPerSecond: 8 },
    );
    test = await openTestCell({ gateway });
    const frames: Frame[] = [];
    const delivered: number[] = [];
    const session = await test.cell.session(
      (frame) => frames.push(frame),
      (entryId) => {
        delivered.push(entryId);
      },
    );
    await (await test.cell.submit("Find out about fasting for me", "s-1")).wait(BACKGROUND_CONTEXT);
    await until(
      () =>
        frames.some((frame) => frame.type === "answer" && frame.text.startsWith("Research says")),
      20_000,
    );
    await session.stop();

    const kinds = frames.map((frame) => frame.type);
    expect(kinds).toContain("delta");
    const answers = frames.filter((frame) => frame.type === "answer" || frame.type === "followup");
    // The wake notice is the lead's input, not a message to the person.
    expect(answers.map((frame) => frame.type)).toEqual(["answer", "answer"]);
    expect(answers[1]).toMatchObject({
      text: "Research says: the job did not answer: model_error",
    });
    expect(
      gateway.requests.filter((request) => request.role === "lead" && request.last?.role === "user")
        .length,
    ).toBe(2);
    expect(delivered).toHaveLength(2);
    expect((await test.cell.missed("never-connected")).messages).toHaveLength(2);
  }, 30_000);

  it("sends a long answer as several parts that add up to the answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const gateway = createFauxGateway(() => fauxAssistantMessage([fauxText(long)]), {
      tokensPerSecond: 30,
    });
    test = await openTestCell({ gateway });
    const frames: Frame[] = [];
    const session = await test.cell.session((frame) => frames.push(frame));
    await (await test.cell.submit("Tell me a long thing", "s-2")).wait(BACKGROUND_CONTEXT);
    await until(() => frames.some((frame) => frame.type === "answer"));
    await session.stop();
    const parts = frames.flatMap((frame) => (frame.type === "delta" ? [frame.text] : []));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(long);
    expect(frames.at(-1)).toMatchObject({ type: "answer", text: long });
  }, 30_000);
});

describe("the question frame", () => {
  it("follows the lead's answer that asks the person, once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const respond: Responder = (request) => {
      if (request.role === "research") {
        return request.last?.role === "toolResult"
          ? fauxAssistantMessage([fauxText(`Filled in: ${request.lastText}`)])
          : fauxAssistantMessage(
              [fauxToolCall("ask_lead", { question: "Which address goes on the form?" })],
              { stopReason: "toolUse" },
            );
      }
      if (request.lastText === questionNotice(1)) {
        return fauxAssistantMessage([fauxToolCall("ask_person", { job: 1 })], {
          stopReason: "toolUse",
        });
      }
      if (request.lastText === askPersonText(1)) {
        return fauxAssistantMessage([
          fauxText("The passport job needs one fact from you: home or the office?"),
        ]);
      }
      return jobResponder(request);
    };
    test = await openTestCell({ gateway: createFauxGateway(respond) });
    const frames: Frame[] = [];
    const session = await test.cell.session((frame) => frames.push(frame));
    await (
      await test.cell.submit(
        startJobLine({
          title: "renew passport form",
          brief: "fill the form",
          template: "research",
        }),
        "q-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(() => frames.some((frame) => frame.type === "question"));
    await test.cell.harness.waitForIdle(BACKGROUND_CONTEXT);
    await session.stop();
    const kinds = frames
      .filter((frame) => frame.type === "answer" || frame.type === "question")
      .map((frame) => (frame.type === "answer" ? `answer: ${frame.text}` : frame));
    expect(kinds.slice(-2)).toEqual([
      "answer: The passport job needs one fact from you: home or the office?",
      { type: "question", job: 1, title: "renew passport form" },
    ]);
    expect(frames.filter((frame) => frame.type === "question")).toHaveLength(1);
  });
});

describe("the shared frame", () => {
  const link = (consent: "offered" | "shown", payer: "half" | "them" | "you" = "half") => ({
    household: 4,
    role: "other" as const,
    with: "sam",
    consent,
    payer,
    estimateUsd: 0.25,
    outbox: [],
    charges: [],
    resultAt: null,
    waitingBudget: false,
  });

  it("lists the offers the lead gave the person, with who pays", () => {
    const row = (number: number, shared: ReturnType<typeof link>) =>
      ({ number, title: `trip ${number}`, shared }) as unknown as JobRow;
    expect(
      personOffers({
        "1": row(1, link("offered")),
        "2": row(2, link("shown")),
        "3": row(3, link("shown", "them")),
        "4": row(4, { ...link("shown"), role: "requester" } as never),
      }),
    ).toEqual([
      { key: "shared:2", job: 2, title: "trip 2", from: "sam", payer: "half" },
      { key: "shared:3", job: 3, title: "trip 3", from: "sam", payer: "all" },
    ]);
  });

  it("follows the lead's answer that gives the offer, once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = createFauxGateway(() =>
      fauxAssistantMessage([fauxText("Sam asked me to plan the May trip for both of you.")]),
    );
    test = await openTestCell({ gateway });
    const cell = test.cell;
    const n = await cell.harness.commit(async (tx) => {
      const row = await createSharedRow(tx, {
        title: "plan the May trip",
        brief: "plan the May trip",
        priority: "routine",
        deadline: null,
        tier: "cheap",
        effort: { requested: "low", applied: "low" },
        owner: "owner",
        createdAt: 1,
        shared: link("offered"),
      });
      return row.number;
    }, BACKGROUND_CONTEXT);
    const frames: Frame[] = [];
    const session = await cell.session((frame) => frames.push(frame));
    await cell.harness.commit(async (tx) => {
      const shared = (await tx.doc(JobBoardDoc)).jobs[String(n)]?.shared;
      if (shared) shared.consent = "shown";
    }, BACKGROUND_CONTEXT);
    await (await cell.submit("anything new?", "sh-1")).wait(BACKGROUND_CONTEXT);
    await until(() => frames.some((frame) => frame.type === "shared"));
    await (await cell.submit("and now?", "sh-2")).wait(BACKGROUND_CONTEXT);
    await until(() => frames.filter((frame) => frame.type === "answer").length === 2);
    await session.stop();
    const kinds = frames
      .filter((frame) => frame.type === "answer" || frame.type === "shared")
      .map((frame) => frame.type);
    expect(kinds).toEqual(["answer", "shared", "answer"]);
    expect(frames.find((frame) => frame.type === "shared")).toEqual({
      type: "shared",
      job: n,
      title: "plan the May trip",
      from: "sam",
      payer: "half",
    });
  });
});
