// The charter scenario through its sixth step, on one fresh person cell behind the worker's
// routes, with the faux model standing in for the lead's and the jobs' decisions and guard mode
// shadow. The chat is printed by the command line's own renderer (no TTY); `secbot jobs`,
// `secbot stop`, and `secbot jobs restart` run in process:
//   1. a research request: the lead says `On it: ...` and the board shows the job running;
//   2. a line sent while the lead is mid-turn is answered before any job result, the turn is
//      bookmarked during the answer, and the bookmark is gone after resume_work;
//   3. the job finishes: the board shows one result waiting, the lead pulls it and tells the
//      person;
//   4. a second job fails the same way three times and pauses; the lead raises and restarts it;
//      when both are used the job fails and the chat shows its question line;
//   5. a third job reads a page that gives the agent orders: it is blocked with its reason, and
//      the lead is told;
//   6. two running jobs stop with `secbot stop`, the board keeps them, and `secbot jobs restart`
//      resumes one from its kept brief.
// With SECBOT_EVIDENCE_DIR set, the whole transcript is written to charter-1-6.txt there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BookmarkDoc, createDecisionModels, StopDoc } from "@secbot/cell-harness";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
  until,
} from "@secbot/cell-harness/testing";
import {
  createHold,
  jobResponder,
  PULL_JOB_1,
  RESEARCH_JOB,
  startJobLine,
} from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAGES, standInDecide } from "../../cell-harness/test/injection-fixtures.ts";
import {
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import { frameRenderer } from "../../cli/src/commands/chat.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, workerFetch } from "./guard-setup.ts";

let s: GuardSetup | undefined;
let stub: StubOpenRouter | undefined;
let hold: ReturnType<typeof createHold> | undefined;
let dir: string | undefined;
afterEach(async () => {
  for (const role of ["lead", "research"]) hold?.release(role);
  hold = undefined;
  if (s !== undefined) await closeAll(s);
  s = undefined;
  await stub?.close();
  stub = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

/**
 * The lead and the jobs as the scenario scripts them: the lead runs `CALL` lines and relays a
 * pulled result; a household job makes the same failing call each step; a health job reads the
 * page that gives orders; a research job answers its brief.
 */
const charter: Responder = (request) => {
  if (request.role === "lead" && request.last?.role === "toolResult") {
    const pulled = /\nResult:\n([\s\S]*)$/.exec(request.lastText)?.[1];
    if (pulled !== undefined) {
      return fauxAssistantMessage([fauxText(`Research says: ${pulled.trim()}`)]);
    }
  }
  if (request.role === "household") {
    return fauxAssistantMessage([fauxToolCall("household_read", { document: "no such list!" })], {
      stopReason: "toolUse",
    });
  }
  if (request.role === "health" && request.last?.role !== "toolResult") {
    return fauxAssistantMessage([fauxToolCall("read_fixture_page", { page: "injected" })], {
      stopReason: "toolUse",
    });
  }
  return jobResponder(request);
};

async function secbot(setup: GuardSetup, ...argv: string[]) {
  dir ??= await mkdtemp(join(tmpdir(), "secbot-charter-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: async function* () {},
  };
  const env = { SECBOT_CONFIG_DIR: dir, SECBOT_CELL_URL: `http://${HOST}` };
  const code = await run(argv, { environment: { env, home: dir }, io, fetch: workerFetch(setup) });
  return { code, out, err };
}

describe("the charter scenario, steps 1 to 6", () => {
  it("runs a job, steers the lead, pulls a result, escalates, blocks, stops, and restarts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub = await startStubOpenRouter();
    stub.decide = standInDecide;
    hold = createHold();
    const held = hold;
    s = await guardSetup(undefined, {
      respond: held.wrap(charter),
      fixturePages: FIXTURE_PAGES,
      guard: {
        decision: createDecisionModels({ apiKey: "decisions-test-key-0000", baseUrl: stub.origin }), // gitleaks:allow (fake test key)
      },
    });
    const setup = s;
    const opened = await route(
      new Request(`http://${HOST}/v1/cells/owner/status`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
      setup.env,
    );
    expect(opened.status).toBe(200);
    const harness = setup.harness("owner");

    // The chat as the command line prints it, with the person's lines and each command.
    let transcript = "";
    const io: Io = {
      stdout: (text) => {
        transcript += text;
      },
      stderr: (text) => {
        transcript += `[stderr] ${text}`;
      },
      lines: async function* () {},
    };
    const renderer = frameRenderer(io);
    const session = await harness.session((frame) =>
      renderer.handle(JSON.parse(JSON.stringify(frame))),
    );
    let said = 0;
    const say = async (text: string) => {
      transcript += `${text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n`;
      await setup.cells.get("owner")?.submitInput("owner", text, `charter-${++said}`, "steer");
    };
    const command = async (...argv: string[]) => {
      const ran = await secbot(setup, ...argv);
      transcript += `$ secbot ${argv.join(" ")}\n${ran.out}${ran.err
        .split("\n")
        .filter(Boolean)
        .map((line) => `[stderr] ${line}\n`)
        .join("")}[exit ${ran.code}]\n`;
      return ran;
    };
    const job = async (n: number) => (await harness.board()).jobs[String(n)];
    const requests = (role: string) =>
      setup.gateway.requests.filter((request) => request.role === role).length;
    const bookmark = async () =>
      (await harness.harness.snapshot(BookmarkDoc, BACKGROUND_CONTEXT))?.bookmark ?? null;

    try {
      // 1. The research request: the lead's one line, and the job running on the board.
      held.hold("research");
      transcript += "## 1. a research job\n";
      await say(RESEARCH_JOB);
      const notice = "On it: comparing direct flights to Lisbon in May (job 1, research, mid)";
      await until(() => transcript.includes(notice));
      await until(() => held.waiting("research") === 1);
      const board1 = await command("jobs");
      expect(board1.out).toMatch(/^1 {3}comparing direct flig\.\.\. .* running$/m);

      // 2. A line while the lead is mid-turn: answered first; the turn is bookmarked until
      // resume_work.
      transcript += "## 2. a message mid-job\n";
      held.hold("lead");
      await say("How is the flights job going?");
      await until(() => held.waiting("lead") === 1);
      await say("What time is it?");
      expect(await bookmark()).toMatchObject({ note: null });
      held.release("lead");
      await until(() => transcript.includes("lead says: What time is it?"));
      expect(await bookmark()).not.toBeNull();
      expect((await job(1))?.result).toBeNull();
      await say("CALL resume_work {}");
      await until(async () => (await bookmark()) === null);

      // 3. The job finishes: one result waits; the lead pulls it and tells the person.
      transcript += "## 3. the result\n";
      held.release("research");
      await until(async () => (await job(1))?.status === "done");
      await harness.harness.waitForIdle(BACKGROUND_CONTEXT);
      const board3 = await command("jobs");
      expect(board3.out.split("\n")[0]).toContain("[ results waiting: 1 ]");
      await say(PULL_JOB_1);
      await until(() => transcript.includes("Research says: research finding: evidence is mixed."));

      // 4. The same failure three times pauses the job; a raise and a restart are used, then the
      // job fails and asks the person.
      transcript += "## 4. a failing job\n";
      await say(
        startJobLine({ title: "shopping list", brief: "Read the list.", template: "household" }),
      );
      await until(async () => (await job(2))?.status === "paused" && requests("household") === 3);
      expect((await job(2))?.pause?.reason).toBe("loop");
      await say('CALL set_job {"job":2,"effort":"high"}');
      await until(async () => requests("household") === 6 && (await job(2))?.status === "paused");
      await say('CALL restart_job {"job":2,"note":"the list name was wrong"}');
      await until(async () => requests("household") === 9 && (await job(2))?.status === "paused");
      await say('CALL set_job {"job":2,"tier":"frontier"}');
      await until(async () => (await job(2))?.status === "failed");
      expect(await job(2)).toMatchObject({
        attempts: { raises: 1, restarts: 1 },
        question: { from: "escalation", toPerson: true },
      });
      await until(() => transcript.includes("[ job 2 asks ] answer with /answer 2 <text>"));

      // 5. A page that gives the agent orders: the job is blocked, and the lead is told.
      transcript += "## 5. a page with orders\n";
      await say(
        startJobLine({ title: "gym prices", brief: "Compare gym prices.", template: "health" }),
      );
      await until(async () => (await job(3))?.status === "blocked");
      expect((await job(3))?.block).toMatchObject({ cause: "hit", kind: "page" });
      await until(() =>
        setup.gateway.requests.some(
          (request) => request.role === "lead" && request.lastText.startsWith("[job 3 "),
        ),
      );
      const board5 = await command("jobs");
      expect(board5.out).toContain(
        "      a page tried to give the agent orders; nothing from it was used",
      );

      // 6. Two running jobs stop; the board keeps them; one restarts from its kept brief.
      transcript += "## 6. stop and restart\n";
      held.hold("research");
      await say(
        [
          startJobLine({ title: "train times", brief: "Find trains.", template: "research" }),
          startJobLine({ title: "hotel list", brief: "Find hotels.", template: "research" }),
        ].join("\n"),
      );
      await until(() => held.waiting("research") === 2);
      const stopping = command("stop");
      await until(
        async () => (await harness.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
      );
      held.release("research");
      const stopped = await stopping;
      expect(stopped.out.split("\n")[0]).toBe("[ stopped ] 2 jobs. Their state is kept.");
      for (const n of [4, 5]) expect((await job(n))?.status).toBe("stopped");
      const board6 = await command("jobs");
      for (const n of [4, 5]) expect(board6.out).toContain(`secbot jobs restart ${n}`);
      const restarted = await command("jobs", "restart", "4");
      expect(restarted.out).toBe(
        "[ restarted ] #4 train times, from its kept brief and transcript\n",
      );
      await until(async () => (await job(4))?.status === "done");
      expect(await job(4)).toMatchObject({ brief: "Find trains.", resumes: 1 });
      await command("jobs");
    } finally {
      await session.stop();
      const where = process.env.SECBOT_EVIDENCE_DIR;
      if (where !== undefined && where !== "") {
        await mkdir(where, { recursive: true });
        await writeFile(join(where, "charter-1-6.txt"), transcript);
      }
    }
  }, 120_000);
});
