// The CLI against an in-process fake cell: chat streams and shows a follow-up that arrives while
// the session is open, a dropped connection resends unacknowledged lines under the
// same request id, missed lists in order, model set refuses an unknown id with exit 1,
// model cap changes a tier's per-job cap, specialist add adds a job template and the cell's
// refusal of a model reaches stderr, device new prints only the hash line, and a refused key fails.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answeredLine, answerJobOf } from "../src/commands/job-answer.ts";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-cli-"));
});
afterEach(async () => {
  await cell?.close();
  cell = undefined;
  await rm(dir, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function testIo(lines: (out: () => string) => AsyncIterable<string> = async function* () {}) {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: () => lines(() => out),
  };
  return { io, out: () => out, err: () => err };
}

async function setup(): Promise<{
  environment: { env: Record<string, string>; home: string };
  key: string;
}> {
  const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
  const made = testIo();
  expect(await run(["device", "new", "laptop"], { environment, io: made.io })).toBe(0);
  const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
  cell = await startFakeCell(device.key);
  environment.env.SECBOT_CELL_URL = cell.url;
  return { environment, key: device.key };
}

describe("secbot device new", () => {
  it("saves the key with mode 0600 and prints only the name, person, and hash", async () => {
    const environment = { env: { SECBOT_CONFIG_DIR: dir }, home: dir };
    const { io, out } = testIo();
    expect(await run(["device", "new", "laptop"], { environment, io })).toBe(0);
    const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as {
      key: string;
      person: string;
    };
    expect(device.person).toBe("owner");
    const hash = createHash("sha256").update(device.key).digest("hex");
    expect(out()).toContain(`laptop:owner:${hash}`);
    expect(out()).not.toContain(device.key);
    if (process.platform !== "win32")
      expect((await stat(join(dir, "device.json"))).mode & 0o777).toBe(0o600);
    const again = testIo();
    expect(await run(["device", "new", "laptop"], { environment, io: again.io })).toBe(1);
    expect(again.err()).toContain("already exists");
  });
});

describe("secbot chat", () => {
  it("streams the answer and shows a follow-up that arrives while the session is open", async () => {
    const { environment } = await setup();
    if (cell === undefined) throw new Error("no cell");
    cell.onInput = (input, socket) => {
      socket.send({ type: "delta", text: "Let me " });
      socket.send({ type: "delta", text: "ask research." });
      socket.send({ type: "answer", entryId: 3, text: "Let me ask research." });
      setTimeout(() => {
        socket.send({ type: "waiting", on: true });
        socket.send({ type: "waiting", on: false });
        socket.send({
          type: "followup",
          entryId: 5,
          from: "research",
          text: `found it for: ${input.text}`,
        });
      }, 100);
    };
    const { io, out } = testIo(async function* (output) {
      yield "find out about fasting";
      await waitFor(() => output().includes("[from research]"));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    expect(out()).toBe(
      [
        "connected to owner lead",
        "Let me ask research.",
        "waiting for the model",
        "the model is answering again",
        "[from research] found it for: find out about fasting",
        "",
      ].join("\n"),
    );
    expect(cell.inputs).toEqual([
      { type: "input", text: "find out about fasting", requestId: expect.stringMatching(/^cli-/) },
    ]);
  });

  it("reconnects after a dropped connection and resends unacknowledged lines once", async () => {
    const { environment } = await setup();
    if (cell === undefined) throw new Error("no cell");
    const fake = cell;
    let drops = 0;
    // The first connection drops before the cell acknowledges anything.
    const original = fake.sockets.length;
    const { io, out } = testIo(async function* (output) {
      await waitFor(() => fake.sockets.length > original);
      const first = fake.sockets[0];
      if (first !== undefined && drops++ === 0) first.drop();
      yield "hello after a drop";
      await waitFor(() => output().includes("hi"));
    });
    fake.onInput = (_input, socket) => {
      socket.send({ type: "delta", text: "hi" });
      socket.send({ type: "answer", entryId: 1, text: "hi" });
    };
    expect(await run(["chat"], { environment, io, reconnectMs: 20 })).toBe(0);
    expect(out()).toContain("connection lost; reconnecting");
    expect(fake.inputs).toHaveLength(1);
  });

  it("prints a job's question line once and answers it only with an exact /answer", async () => {
    const { environment } = await setup();
    if (cell === undefined) throw new Error("no cell");
    const fake = cell;
    fake.jobAnswers[11] = [200, { job: 11, title: "renew passport form" }];
    fake.jobAnswers[12] = [409, { error: "job 12 has no question waiting" }];
    fake.onInput = (_input, socket) => {
      socket.send({ type: "delta", text: "Which address, home or the office?" });
      socket.send({ type: "answer", entryId: 2, text: "Which address, home or the office?" });
      socket.send({ type: "question", job: 11, title: "renew passport form" });
      // A reconnect or a second notice of the same question prints nothing new.
      socket.send({ type: "question", job: 11, title: "renew passport form" });
    };
    const { io, out, err } = testIo(async function* (output) {
      yield "the passport form";
      await waitFor(() => output().includes("[ job 11 asks ]"));
      yield "/answer eleven home";
      yield "/answer 12 home";
      yield "/answer 11 home address";
      await waitFor(() => output().includes("[ answered ]"));
    });
    expect(await run(["chat"], { environment, io })).toBe(0);
    expect(out()).toBe(
      [
        "connected to owner lead",
        "Which address, home or the office?",
        "",
        "[ job 11 asks ] answer with /answer 11 <text>",
        "[ answered ] #11 renew passport form continues",
        "",
      ].join("\n"),
    );
    expect(err()).toBe(
      [
        "not sent: answer with /answer <#> <text>",
        "secbot: job 12 has no question waiting",
        "",
      ].join("\n"),
    );
    // Only the plain line reached the lead; the answers went to the answer route.
    expect(fake.inputs.map((input) => input.text)).toEqual(["the passport form"]);
    expect(
      fake.calls.filter((each) => each.path.endsWith("/answer")).map((each) => each.body),
    ).toEqual([{ text: "home" }, { text: "home address" }]);
    for (const line of out().split("\n")) {
      expect(line.length).toBeLessThan(80);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control codes.
      expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it("keeps an answered line within 78 columns for a long title", () => {
    const line = answeredLine(3, "x".repeat(120));
    expect(line.length).toBe(78);
    expect(line.endsWith("… continues")).toBe(true);
    expect(answeredLine(4, "two\nlines")).toBe("[ answered ] #4 two lines continues");
    expect(answerJobOf("/answer 4 home")).toEqual({ kind: "answer", job: 4, text: "home" });
    expect(answerJobOf("/answer 4")).toEqual({ kind: "malformed" });
    expect(answerJobOf("/Answer 4 home")).toEqual({ kind: "malformed" });
    expect(answerJobOf("answer 4 home")).toEqual({ kind: "other" });
  });

  it("fails with the cell's reason when the device is refused", async () => {
    const { environment } = await setup();
    await writeFileKey(dir, "not-the-registered-key");
    const { io, err } = testIo();
    expect(await run(["chat"], { environment, io })).toBe(1);
    expect(err()).toContain("the cell refused this device (refused: unknown_key)");
  });
});

async function writeFileKey(directory: string, key: string) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(directory, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key }),
  );
}

describe("secbot commands", () => {
  it("lists missed messages in order", async () => {
    const { environment } = await setup();
    if (cell === undefined) throw new Error("no cell");
    cell.missed = [
      { kind: "answer", entryId: 3, text: "first" },
      { kind: "followup", entryId: 4, from: "research", text: "second" },
      { kind: "answer", entryId: 6, text: "third" },
    ];
    const { io, out } = testIo();
    expect(await run(["missed"], { environment, io })).toBe(0);
    expect(out()).toBe("lead: first\n[from research] second\nlead: third\n");
    const again = testIo();
    expect(await run(["missed"], { environment, io: again.io })).toBe(0);
    expect(again.out()).toBe("no missed messages\n");
  });

  it("lists and changes models, refusing an unknown id with exit 1", async () => {
    const { environment } = await setup();
    const listed = testIo();
    expect(await run(["model", "list"], { environment, io: listed.io })).toBe(0);
    expect(listed.out()).toContain("lead      anthropic/claude-opus-5.5  (release default)");
    const changed = testIo();
    expect(
      await run(["model", "set", "lead", "anthropic/claude-sonnet-5.5"], {
        environment,
        io: changed.io,
      }),
    ).toBe(0);
    expect(changed.out()).toBe("lead now uses anthropic/claude-sonnet-5.5 from its next turn\n");
    const refused = testIo();
    expect(
      await run(["model", "set", "lead", "openai/nope"], { environment, io: refused.io }),
    ).toBe(1);
    expect(refused.err()).toContain('unknown model "openai/nope"');
    const usage = testIo();
    expect(await run(["model", "set", "lead"], { environment, io: usage.io })).toBe(2);
  });

  it("shows tier caps and changes one, refusing an unknown tier with exit 1", async () => {
    const { environment } = await setup();
    const listed = testIo();
    expect(await run(["model", "list"], { environment, io: listed.io })).toBe(0);
    expect(listed.out()).toContain(
      "cheap     anthropic/claude-haiku-4.5  (release default)  cap $0.25 per job",
    );
    const changed = testIo();
    expect(await run(["model", "cap", "mid", "2.5"], { environment, io: changed.io })).toBe(0);
    expect(changed.out()).toBe("mid jobs now cap at $2.5\n");
    expect(cell?.calls.at(-1)).toMatchObject({
      method: "PUT",
      path: "/v1/cells/owner/tiers/mid/cap",
      body: { usd: "2.5" },
    });
    const refused = testIo();
    expect(await run(["model", "cap", "huge", "1"], { environment, io: refused.io })).toBe(1);
    expect(refused.err()).toContain('unknown tier "huge"');
    const usage = testIo();
    expect(await run(["model", "cap", "mid"], { environment, io: usage.io })).toBe(2);
  });

  it("adds a job template, and the cell's refusal of a model reaches stderr", async () => {
    const { environment } = await setup();
    const { io, out } = testIo();
    expect(
      await run(["specialist", "add", "tax", "--instruction", "Track forms."], { environment, io }),
    ).toBe(0);
    expect(out()).toBe(
      "added tax as a job template; the lead can start jobs from it from its next turn\n",
    );
    expect(cell?.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/cells/owner/specialists",
      body: { name: "tax", instruction: "Track forms." },
    });
    const refused = testIo();
    const argv = [
      "specialist",
      "add",
      "garden",
      "--instruction",
      "Plants.",
      "--model",
      "anthropic/claude-haiku-4.5",
    ];
    expect(await run(argv, { environment, io: refused.io })).toBe(1);
    expect(refused.err()).toContain("a template starts on a tier");
    expect(refused.out()).toBe("");
  });

  it("explains a missing cell address and shows usage for an unknown command", async () => {
    const environment = { env: { SECBOT_CONFIG_DIR: dir }, home: dir };
    const missing = testIo();
    expect(await run(["missed"], { environment, io: missing.io })).toBe(1);
    expect(missing.err()).toContain("no cell address");
    const unknown = testIo();
    expect(await run(["dance"], { environment, io: unknown.io })).toBe(2);
    expect(unknown.err()).toContain("usage:");
    const flag = testIo();
    expect(await run(["chat", "--to", "research"], { environment, io: flag.io })).toBe(2);
  });
});

describe("secbot jobs and secbot stop", () => {
  it("lists the four job and stop help lines exactly", async () => {
    const environment = { env: { SECBOT_CONFIG_DIR: dir }, home: dir };
    const help = testIo();
    expect(await run(["--help"], { environment, io: help.io })).toBe(0);
    const lines = help.out().split("\n");
    const at = lines.indexOf(
      "  secbot jobs                         list live jobs and jobs from the last 24 h",
    );
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 4)).toEqual([
      "  secbot jobs                         list live jobs and jobs from the last 24 h",
      "  secbot jobs urgent|deadline|move    change a job's place in the queue",
      "  secbot jobs restart <#>             restart a stopped job",
      "  secbot stop [--all]                 stop every running job now (--all: owner)",
    ]);
    for (const line of lines.slice(at, at + 4)) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("refuses secbot stop --all and secbot jobs --person without an operator key", async () => {
    const { environment } = await setup();
    for (const argv of [
      ["stop", "--all"],
      ["jobs", "--person", "sam"],
      ["jobs", "--household"],
    ]) {
      const refused = testIo();
      expect(await run(argv, { environment, io: refused.io })).toBe(1);
      expect(refused.err()).toContain("secbot: no operator key: set SECBOT_OPERATOR_KEY");
      expect(refused.out()).toBe("");
    }
    expect(cell?.calls).toEqual([]);
  });

  it("runs the board, a reorder, a restart, and the stop through the command line", async () => {
    const { environment } = await setup();
    const fake = cell;
    if (fake === undefined) throw new Error("no cell");
    const board = testIo();
    expect(await run(["jobs"], { environment, io: board.io })).toBe(0);
    expect(board.out()).toContain("JOBS  owner  [ live: 0 ] [ waiting results: 0 ]  [ shadow ]");
    fake.priorityAnswers[4] = [
      200,
      {
        job: 4,
        title: "train times",
        priority: "routine",
        deadline: null,
        place: 1,
        of: 2,
        before: 1,
      },
    ];
    const moved = testIo();
    expect(await run(["jobs", "move", "4", "--before", "1"], { environment, io: moved.io })).toBe(
      0,
    );
    expect(moved.out()).toBe("[ moved ] #4 train times -> now before #1, 1st of 2 live jobs\n");
    const restart = testIo();
    expect(await run(["jobs", "restart", "22"], { environment, io: restart.io })).toBe(1);
    expect(restart.err()).toBe("no stopped job #22\n");
    const stopped = testIo();
    expect(await run(["stop"], { environment, io: stopped.io })).toBe(0);
    expect(stopped.out()).toBe(
      "[ stopped ] nothing was running. Routines and reminders keep their schedule.\n",
    );
    const owner = testIo();
    environment.env.SECBOT_OPERATOR_KEY = fake.operatorKey;
    expect(await run(["jobs", "--person", "sam"], { environment, io: owner.io })).toBe(0);
    expect(owner.out().split("\n")[0]).toBe(
      "JOBS  sam (operator key)  [ live: 0 ] [ waiting results: 0 ]  [ shadow ]",
    );
    const both = testIo();
    expect(
      await run(["jobs", "--person", "sam", "--household"], { environment, io: both.io }),
    ).toBe(2);
  });
});
