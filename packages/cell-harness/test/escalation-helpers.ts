// Shared steps of the escalation tests: a job that pauses on the loop guard, and the lead's
// scripted tool calls.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect } from "vitest";
import {
  type FauxRequest,
  fauxAssistantMessage,
  fauxToolCall,
  type Responder,
  type TestCell,
  until,
} from "./fixtures.ts";
import { toolResultsOf } from "./job-helpers.ts";
import { jobResponder, startJobLine } from "./responders.ts";

export const job = async (t: TestCell, n = 1) => (await t.cell.board()).jobs[String(n)];

/** A research job that always makes the same failing call: it pauses after three. */
export const failingResearch: Responder = (request: FauxRequest) =>
  request.role === "research"
    ? fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
        stopReason: "toolUse",
      })
    : jobResponder(request);

export const researchRequests = (t: TestCell) =>
  t.gateway.requests.filter((request) => request.role === "research").length;

let lines = 0;
/** The lead calls one tool from a scripted line and returns its result text. */
export async function leadCalls(
  t: TestCell,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const before = (await toolResultsOf(t.cell.root)).length;
  await (await t.cell.submit(`CALL ${tool} ${JSON.stringify(args)}`, `lead-${++lines}`)).wait(
    BACKGROUND_CONTEXT,
  );
  const results = await toolResultsOf(t.cell.root);
  expect(results.length).toBe(before + 1);
  return results.at(-1) ?? "";
}

export async function startPausedJob(t: TestCell): Promise<void> {
  await (
    await t.cell.submit(
      startJobLine({ title: "flights", brief: "find flights", template: "research" }),
      "start",
    )
  ).wait(BACKGROUND_CONTEXT);
  await until(async () => (await job(t))?.status === "paused");
}
