// AC-22 end to end: the worker's routes and a real person cell on the stand-in with the faux
// model. A job asks the lead, the lead hands the question to the person and asks in its own words;
// the command line's renderer prints the lead's line, a blank line, and the job's line; the job
// makes no model request while it waits; the person's /answer goes through the answer route and
// the job continues to done. With SECBOT_EVIDENCE_DIR set, the transcript is written there.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
  until,
} from "@secbot/cell-harness/testing";
import { jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameRenderer } from "../../cli/src/commands/chat.ts";
import { answerJob } from "../../cli/src/commands/job-answer.ts";
import { CellClient } from "../../cli/src/client.ts";
import type { Io } from "../../cli/src/io.ts";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, workerFetch } from "./guard-setup.ts";

let s: GuardSetup | undefined;
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  vi.restoreAllMocks();
});

const ASKED = "The passport job needs one fact from you: home or the office?";

/** A research job asks which address; the lead puts it to the person in its own words. */
const respond: Responder = (request) => {
  if (request.role === "research") {
    return request.last?.role === "toolResult"
      ? fauxAssistantMessage([fauxText(`Form filled with: ${request.lastText}`)])
      : fauxAssistantMessage(
          [fauxToolCall("ask_lead", { question: "Which address goes on the form?" })],
          { stopReason: "toolUse" },
        );
  }
  if (request.lastText.startsWith("[job 1 question:")) {
    return fauxAssistantMessage([fauxToolCall("ask_person", { job: 1 })], {
      stopReason: "toolUse",
    });
  }
  if (request.lastText.startsWith("Ask the person")) {
    return fauxAssistantMessage([fauxText(ASKED)]);
  }
  return jobResponder(request);
};

describe("a job's question in secbot chat, end to end (AC-22)", () => {
  it("prints the lead's line, a blank line, and the job's line; /answer continues the job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await guardSetup(undefined, { respond });
    const setup = s;
    const status = await route(
      new Request(`http://${HOST}/v1/cells/owner/status`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
      setup.env,
    );
    expect(status.status).toBe(200);
    let out = "";
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        out += `[stderr] ${text}`;
      },
      lines: async function* () {},
    };
    const renderer = frameRenderer(io);
    const harness = setup.harness("owner");
    const session = await harness.session((frame) =>
      renderer.handle(JSON.parse(JSON.stringify(frame))),
    );
    await setup.cells
      .get("owner")
      ?.submitInput(
        "owner",
        startJobLine({
          title: "renew passport form",
          brief: "fill the form",
          template: "research",
        }),
        "chat-q1",
      );
    await until(() => out.includes("[ job 1 asks ]"));
    await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
    const lines = out.split("\n");
    const asked = lines.indexOf(ASKED);
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(lines.slice(asked, asked + 3)).toEqual([
      ASKED,
      "",
      "[ job 1 asks ] answer with /answer 1 <text>",
    ]);
    const requests = () =>
      setup.gateway.requests.filter((request) => request.role === "research").length;
    const waiting = requests();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests()).toBe(waiting);
    expect((await harness.board()).jobs["1"]?.status).toBe("waiting");

    const client = new CellClient(
      `http://${HOST}`,
      { name: "laptop", person: "owner", key: KEY },
      workerFetch(setup),
    );
    out += "> /answer 1 home address\n";
    await answerJob(client, io, 1, "home address");
    expect(out).toContain("[ answered ] #1 renew passport form continues\n");
    await until(async () => (await harness.board()).jobs["1"]?.status === "done");
    expect((await harness.board()).jobs["1"]?.result?.text).toBe(
      "Form filled with: The person answers: home address",
    );
    await session.stop();
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(80);
    const where = process.env.SECBOT_EVIDENCE_DIR;
    if (where !== undefined && where !== "") {
      await mkdir(where, { recursive: true });
      await writeFile(join(where, "jobs-question-chat-ac22.txt"), out);
    }
  });
});
