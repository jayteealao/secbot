// The injection check end to end, on the stand-in: a cell in shadow mode with the faux models, the
// stub decisions route (answered by the stand-in), and the fixture pages. A job reads a page with
// the fixture tool; clean content is kept and the job goes on; an order, a timeout, or an error
// stops the job, keeps nothing of the page, and tells the lead.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { type Conversation, UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkContent } from "../src/content-check.ts";
import { createDecisionModels } from "../src/decision-model.ts";
import { readGuardMode } from "../src/guard-settings.ts";
import {
  CONTENT_CHECK_MAX_BYTES,
  CONTENT_CHUNK_BYTES,
  CONTENT_CHUNK_OVERLAP_BYTES,
  GUARD_USAGE_KEYS,
} from "../src/release-defaults.ts";
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
import { FIXTURE_PAGES, standInDecide } from "./injection-fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { jobResponder, RESEARCH_JOB } from "./responders.ts";
import { DECISIONS_ROUTE, type StubOpenRouter, startStubOpenRouter } from "./stub-openrouter.ts";

const KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)

let stub: StubOpenRouter;
let test: TestCell | undefined;
beforeEach(async () => {
  stub = await startStubOpenRouter();
  stub.decide = standInDecide;
});
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  await stub.close();
  vi.restoreAllMocks();
});

type Page = keyof typeof FIXTURE_PAGES;

/** A research job that reads `page` with the fixture tool, then answers. */
const readsPage =
  (page: Page): Responder =>
  (request) => {
    if (request.role !== "research") return jobResponder(request);
    if (request.last?.role === "toolResult") {
      return fauxAssistantMessage([fauxText("The page is read; here is the summary.")]);
    }
    return fauxAssistantMessage([fauxToolCall("read_fixture_page", { page })], {
      stopReason: "toolUse",
    });
  };

/** Opens a shadow-mode cell whose job reads `page`, and starts the job. */
async function readJob(page: Page, contentTimeoutMs?: number): Promise<TestCell> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  test = await openTestCell({
    gateway: createFauxGateway(readsPage(page)),
    fixturePages: FIXTURE_PAGES,
    guard: {
      decision: createDecisionModels({
        apiKey: KEY,
        baseUrl: stub.origin,
        ...(contentTimeoutMs === undefined ? {} : { contentTimeoutMs }),
      }),
    },
  });
  expect((await readGuardMode(test.cell.harness, BACKGROUND_CONTEXT)).mode).toBe("shadow");
  await (await test.cell.submit(RESEARCH_JOB, `read-${page}`)).wait(BACKGROUND_CONTEXT);
  return test;
}

const row = async (t: TestCell) => (await t.cell.board()).jobs["1"];

async function jobConversation(t: TestCell): Promise<Conversation> {
  const id = (await row(t))?.conversationId;
  const conversation =
    id == null ? undefined : await t.cell.harness.conversation(id, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("no job conversation");
  return conversation as Conversation;
}

/** The decisions requests that asked the content question. */
const contentRequests = () =>
  stub.seen.filter(
    (request) =>
      request.path === DECISIONS_ROUTE &&
      Object.hasOwn((request.body.questions ?? {}) as object, "injection"),
  );

const SIZES = {
  chunkBytes: CONTENT_CHUNK_BYTES,
  overlapBytes: CONTENT_CHUNK_OVERLAP_BYTES,
  maxBytes: CONTENT_CHECK_MAX_BYTES,
};

describe("clean content is kept and the job goes on (AC-24)", () => {
  it("keeps the clean page exactly, marks the job, and books the check on the job", async () => {
    const t = await readJob("clean");
    await until(async () => (await row(t))?.status === "done");
    const conversation = await jobConversation(t);
    expect(await toolResultsOf(conversation)).toEqual([FIXTURE_PAGES.clean]);
    expect(await row(t)).toMatchObject({
      status: "done",
      outside: { kinds: ["page"], tools: ["read_fixture_page"] },
      block: null,
      result: { kind: "routine", text: "The page is read; here is the summary.", pulledAt: null },
    });
    // One request per chunk, each asking only the content question.
    const asked = contentRequests();
    expect(asked).toHaveLength(chunkContent(FIXTURE_PAGES.clean, SIZES).chunks.length);
    for (const request of asked) {
      expect(Object.keys(request.body.questions as object)).toEqual(["injection"]);
    }
    // The check's cost is the job's: the guard's decision on the read plus the check, 400 tokens
    // each, on the job conversation's ledger.
    const usage = await t.cell.harness.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT);
    const decision = (usage?.tools as Record<string, Usage> | undefined)?.[
      GUARD_USAGE_KEYS.decision
    ];
    expect(decision?.input).toBe(400 * (1 + asked.length));
    expect(decision?.cost.total).toBeGreaterThan(0);
  });
});
