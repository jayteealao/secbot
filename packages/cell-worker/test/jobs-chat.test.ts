// `secbot chat` with jobs, against the worker's routes and a real person cell on the stand-in with
// the faux model: the cell's session frames are printed by the command line's own chat renderer
// (no TTY). The lead starts a research job and tells the person in one line (AC-1), which a
// device that was away reads as `lead: On it: ...` through `secbot missed`; a line the
// person sends while the lead is mid-turn with three jobs open steers the lead: it is answered
// before any job result reaches the lead, and the interrupted turn is bookmarked (AC-7). With
// SECBOT_EVIDENCE_DIR set, each transcript is written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BookmarkDoc } from "@secbot/cell-harness";
import { type Responder, until } from "@secbot/cell-harness/testing";
import {
  createHold,
  JOB_BRIEF,
  jobResponder,
  RESEARCH_JOB,
  startJobLine,
} from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entriesOf, entryRole, entryText } from "../../cell-harness/test/job-helpers.ts";
import { frameRenderer } from "../../cli/src/commands/chat.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, workerFetch } from "./guard-setup.ts";

let s: GuardSetup | undefined;
let holds: ReturnType<typeof createHold>[] = [];
let dir: string | undefined;
afterEach(async () => {
  // A held model call would keep its job running past the close.
  for (const hold of holds) for (const role of ["lead", "research"]) hold.release(role);
  holds = [];
  if (s !== undefined) await closeAll(s);
  s = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

/** A hold on model requests, released after the test whatever happens. */
function heldModels() {
  const hold = createHold();
  holds.push(hold);
  return hold;
}

/** Runs `secbot <argv>` in process against the worker as the owner's laptop. */
async function secbot(setup: GuardSetup, ...argv: string[]) {
  dir ??= await mkdtemp(join(tmpdir(), "secbot-jobs-chat-"));
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
  const code = await run(argv, {
    environment: { env, home: dir },
    io,
    fetch: workerFetch(setup),
  });
  return { code, out, err };
}

/** Opens the owner's cell through the device route and prints its session with the renderer. */
async function chatSession(setup: GuardSetup) {
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
  // The frames as the socket carries them: JSON, read by the command line's own renderer.
  const session = await harness.session((frame) =>
    renderer.handle(JSON.parse(JSON.stringify(frame))),
  );
  /** The person's line, as the chat socket sends it: it steers a busy lead. */
  const say = async (text: string, requestId: string) => {
    out += `${text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n`;
    await setup.cells.get("owner")?.submitInput("owner", text, requestId, "steer");
  };
  return { harness, session, say, out: () => out };
}

async function evidence(name: string, text: string) {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(join(where, name), text);
}

/** No escape codes or other control characters but newlines. */
const plain = (text: string) =>
  [...text].every((char) => {
    const code = char.charCodeAt(0);
    return char === "\n" || (code >= 32 && code !== 127);
  });

describe("secbot chat with jobs", () => {
  it("prints the one-line job notice and records every board field (AC-1)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = heldModels();
    hold.hold("research");
    s = await guardSetup(undefined, { respond: hold.wrap(jobResponder) });
    const chat = await chatSession(s);
    await chat.say(RESEARCH_JOB, "chat-ac1");
    const said = "On it: comparing direct flights to Lisbon in May (job 1, research, mid)";
    await until(() => chat.out().includes(said));
    await chat.session.stop();
    // The live chat streams the lead's answer as its own line.
    expect(chat.out().split("\n")).toContain(said);
    expect(plain(chat.out())).toBe(true);
    // A device that was away reads it with the lead's name, the job notice line of the contract.
    const missed = await secbot(s, "missed");
    const notice = `lead: ${said}`;
    expect(missed.code).toBe(0);
    expect(missed.out.split("\n")).toContain(notice);
    expect(notice.length).toBeLessThan(80);
    expect(plain(missed.out)).toBe(true);
    await evidence(
      "jobs-chat-ac1.txt",
      `${chat.out()}\n$ secbot missed\n${missed.out}${missed.err}[exit ${missed.code}]\n`,
    );

    const row = (await chat.harness.board()).jobs["1"];
    expect(row).toMatchObject({
      number: 1,
      title: "comparing direct flights to Lisbon in May",
      brief: JOB_BRIEF,
      priority: "routine",
      deadline: null,
      template: "research",
      tier: "mid",
      effort: { requested: "medium", applied: expect.any(String) },
      attempts: { raises: 0, restarts: 0 },
      cost: expect.any(Number),
      cap: 1,
      status: "running",
      owner: "owner",
      turn: expect.any(Number),
      createdAt: expect.any(Number),
      endedAt: null,
      result: null,
    });
    expect(row?.conversationId).not.toBeNull();
    expect(row?.taskId).not.toBeNull();
    hold.release("research");
  });

  it("answers a line sent mid-turn before any job result, and bookmarks the turn and its three jobs (AC-7)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hold = heldModels();
    hold.hold("research");
    // The lead's reply after the job round waits until released, so the lead is mid-turn.
    let replied = () => {};
    const reply = new Promise<void>((resolve) => {
      replied = resolve;
    });
    let replying = 0;
    const respond: Responder = async (request) => {
      if (request.role === "lead" && request.last?.role === "toolResult" && replying === 0) {
        replying++;
        await reply;
      }
      return jobResponder(request);
    };
    s = await guardSetup(undefined, { respond: hold.wrap(respond) });
    const chat = await chatSession(s);
    const three = ["one", "two", "three"]
      .map((title) => startJobLine({ title, brief: `Look into ${title}.`, template: "research" }))
      .join("\n");
    await chat.say(three, "chat-ac7-1");
    await until(() => hold.waiting("research") === 3 && replying === 1);
    const turn = Number(
      (await chat.harness.root.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items.find(
        (entry) => entry.kind === "pi.user",
      )?.id,
    );
    await chat.say("What time is it?", "chat-ac7-2");
    const bookmark = (await chat.harness.harness.snapshot(BookmarkDoc, BACKGROUND_CONTEXT))
      ?.bookmark;
    expect(bookmark).toMatchObject({ jobIds: [1, 2, 3], note: null });
    expect(bookmark?.turn).toBeGreaterThan(0);
    expect(Number.isFinite(turn)).toBe(true);
    replied();
    await until(() => chat.out().includes("lead says: What time is it?"));

    // The person's line, then the lead's answer to it, and no job result before them.
    const order = (await entriesOf(chat.harness.root)).map(
      (entry) => `${entryRole(entry)}:${entryText(entry)}`,
    );
    const asked = order.indexOf("user:What time is it?");
    expect(asked).toBeGreaterThan(-1);
    const answered = order.findIndex(
      (line, index) => index > asked && line === "assistant:lead says: What time is it?",
    );
    expect(answered).toBeGreaterThan(asked);
    const pulled = order.findIndex((line) => line.includes("Result:\n"));
    expect(pulled === -1 || pulled > answered).toBe(true);
    await chat.session.stop();
    expect(plain(chat.out())).toBe(true);
    expect(
      chat
        .out()
        .split("\n")
        // The echoed lines are the test's own input, not the command line's output.
        .every((line) => line.startsWith("> ") || line.length <= 80),
    ).toBe(true);
    await evidence("jobs-chat-ac7.txt", chat.out());
    hold.release("research");
  });
});
