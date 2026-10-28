// The injection check end to end, on the stand-in: a cell in shadow mode with the faux models, the
// stub decisions route (answered by the stand-in), and the fixture pages. A job reads a page with
// the fixture tool; clean content is kept and the job goes on; an order, a timeout, or an error
// stops the job, keeps nothing of the page, and tells the lead.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { type Conversation, UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkContent, WITHHELD_TEXT } from "../src/content-check.ts";
import { createDecisionModels } from "../src/decision-model.ts";
import { readGuardMode } from "../src/guard-settings.ts";
import {
  CONTENT_CHECK_MAX_BYTES,
  CONTENT_CHUNK_BYTES,
  CONTENT_CHUNK_OVERLAP_BYTES,
  GUARD_USAGE_KEYS,
} from "../src/release-defaults.ts";
import { leadCalls } from "./escalation-helpers.ts";
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
import { entriesOf, toolResultsOf, wakeNoticesOf } from "./job-helpers.ts";
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

const research = (t: TestCell) =>
  t.gateway.requests.filter((request) => request.role === "research");

/** Every entry of the job conversation, as stored. */
const storedText = async (t: TestCell) =>
  (await entriesOf(await jobConversation(t))).map((entry) => JSON.stringify(entry)).join("\n");

/** Waits for the stop, then checks everything a stop must leave behind. */
async function expectStopped(
  t: TestCell,
  page: Page,
  cause: "hit" | "timeout" | "error",
  reason: string,
) {
  await until(async () => (await row(t))?.status === "blocked");
  const blocked = await row(t);
  expect(blocked).toMatchObject({
    status: "blocked",
    block: { cause, kind: "page", tool: "read_fixture_page" },
    result: { kind: "failure", text: reason },
  });
  const taskId = blocked?.taskId;
  if (taskId == null) throw new Error("no job task");
  const settled = await t.cell.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  expect(settled.state.outcome.status).toBe("aborted");
  // Nothing of the page was kept: not in any entry of the job's conversation.
  const stored = await storedText(t);
  for (const line of FIXTURE_PAGES[page].split("\n")) expect(stored).not.toContain(line);
  expect(await toolResultsOf(await jobConversation(t))).toEqual([WITHHELD_TEXT]);
  // The read was the job's last model step.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(research(t)).toHaveLength(1);
  // The lead was told once, and reads the reason with job_result.
  await until(async () => (await wakeNoticesOf(t.cell.root)).length > 0);
  expect(await wakeNoticesOf(t.cell.root)).toEqual([
    `[job 1 blocked: ${reason}; read it with job_result]`,
  ]);
  expect(await leadCalls(t, "job_result", { job: 1 })).toContain(`Result:\n${reason}`);
}

const HIT = "a page tried to give the agent orders; nothing from it was used";
const NO_ANSWER = "the content check did not answer; stopped to be safe";

describe("an order, a timeout, or an error stops the job in shadow mode (AC-25)", () => {
  it("stops on a page with an injected order", async () => {
    const t = await readJob("injected");
    await expectStopped(t, "injected", "hit", HIT);
    expect((await row(t))?.block?.chunk).toBe(0);
  });

  it("stops when the check times out", async () => {
    stub.delayMs = 300;
    const t = await readJob("clean", 100);
    await expectStopped(t, "clean", "timeout", NO_ANSWER);
  });

  it("stops when the check fails", async () => {
    stub.mode = 500;
    const t = await readJob("clean");
    await expectStopped(t, "clean", "error", NO_ANSWER);
  });
});
