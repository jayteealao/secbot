// `secbot jobs` and its reorder commands against the worker's routes and a real person cell on
// the stand-in with the faux model, run in process with no TTY. Four live jobs are reordered with
// urgent, a deadline, no deadline, and a move; after each, the lead's next request lists the jobs
// in the new order. A board with a row for each status prints each reason line as the approved
// text writes it; no line passes 80 columns and none holds a control code. With
// SECBOT_EVIDENCE_DIR set, each command's output is written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { JobBoardDoc, type JobRow } from "@secbot/cell-harness";
import { until } from "@secbot/cell-harness/testing";
import { createHold, jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyJobExtras } from "../../cell-harness/src/docs.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, workerFetch } from "./guard-setup.ts";

let s: GuardSetup | undefined;
let hold: ReturnType<typeof createHold> | undefined;
let dir: string | undefined;
afterEach(async () => {
  for (const role of ["lead", "research"]) hold?.release(role);
  hold = undefined;
  if (s !== undefined) await closeAll(s);
  s = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

async function secbot(setup: GuardSetup, ...argv: string[]) {
  dir ??= await mkdtemp(join(tmpdir(), "secbot-jobs-cli-"));
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

async function evidence(name: string, ran: { code: number; out: string; err: string }) {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(join(where, `${name}.stdout.txt`), ran.out);
  await writeFile(join(where, `${name}.stderr.txt`), ran.err);
  await writeFile(join(where, `${name}.exit-code`), `${ran.code}\n`);
}

/** Every line within 80 columns, and no control code but the newline. */
const fits = (text: string) => {
  for (const line of text.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(80);
    expect([...line].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)).toBe(
      true,
    );
  }
};

async function openOwner(respond = jobResponder) {
  hold = createHold();
  s = await guardSetup(undefined, { respond: hold.wrap(respond) });
  const opened = await route(
    new Request(`http://${HOST}/v1/cells/owner/status`, {
      headers: { authorization: `Bearer ${KEY}` },
    }),
    s.env,
  );
  expect(opened.status).toBe(200);
  return { setup: s, held: hold, harness: s.harness("owner") };
}

describe("secbot jobs reorder on a real cell", () => {
  it("prints each reorder line, and the lead's next request lists the new order", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { setup, held, harness } = await openOwner();
    held.hold("research");
    const titles = ["flights to Lisbon", "train times", "hotel list", "council tax letter"];
    for (const [index, title] of titles.entries()) {
      await (
        await harness.submit(
          startJobLine({ title, brief: `${title}, please.`, template: "research" }),
          `job-${index}`,
        )
      ).wait(BACKGROUND_CONTEXT);
    }
    await until(() => held.waiting("research") === 4);

    let asked = 0;
    /** The job numbers in the lead's next request, in the order its jobs section lists them. */
    const leadOrder = async () => {
      await (await harness.submit("what is on?", `ask-${++asked}`)).wait(BACKGROUND_CONTEXT);
      const system = setup.gateway.requests.findLast((request) => request.role === "lead")?.system;
      const lines = (system ?? "").split("\n");
      // The latest jobs section: a changed section is sent again after the earlier one.
      const from = lines.lastIndexOf("Live jobs, in queue order:");
      const listed = lines.slice(from + 1);
      const end = listed.findIndex((line) => !line.startsWith("#"));
      return listed
        .slice(0, end === -1 ? listed.length : end)
        .map((line) => Number(line.slice(1).split(" ")[0]));
    };
    expect(await leadOrder()).toEqual([1, 2, 3, 4]);

    const steps: [string[], string, number[]][] = [
      [
        ["jobs", "urgent", "4"],
        "[ urgent ] #4 council tax letter -> now 1st of 4 live jobs\n",
        [4, 1, 2, 3],
      ],
      [
        ["jobs", "deadline", "4", "2026-10-12"],
        "[ due 12 Oct ] #4 council tax letter -> now 1st of 4 live jobs\n",
        [4, 1, 2, 3],
      ],
      [
        ["jobs", "deadline", "4", "clear"],
        "[ no deadline ] #4 council tax letter -> now 4th of 4 live jobs\n",
        [1, 2, 3, 4],
      ],
      [
        ["jobs", "move", "4", "--before", "2"],
        "[ moved ] #4 council tax letter -> now before #2, 2nd of 4 live jobs\n",
        [1, 4, 2, 3],
      ],
    ];
    let transcript = "";
    for (const [argv, line, order] of steps) {
      const ran = await secbot(setup, ...argv);
      transcript += `$ secbot ${argv.join(" ")}\n${ran.out}${ran.err}`;
      expect(ran).toEqual({ code: 0, out: line, err: "" });
      expect(await leadOrder()).toEqual(order);
    }
    const missing = await secbot(setup, "jobs", "urgent", "22");
    transcript += `$ secbot jobs urgent 22\n${missing.out}${missing.err}`;
    expect(missing).toEqual({ code: 1, out: "", err: "no job #22\n" });
    const malformed = await secbot(setup, "jobs", "deadline", "4", "12/10/2026");
    expect(malformed.code).toBe(2);
    await evidence("reorder", { code: 0, out: transcript, err: "" });
    const board = await secbot(setup, "jobs");
    expect(
      board.out
        .split("\n")
        .filter((each) => /^\d/.test(each))
        .map((each) => each.split(" ")[0]),
    ).toEqual(["1", "4", "2", "3"]);
    fits(board.out);
  }, 60_000);
});

describe("secbot jobs on a real cell, a row for each status", () => {
  const NOW = Date.now();
  const HOUR = 60 * 60_000;
  const at = (hour: number, minute: number) => {
    const day = new Date(NOW - 2 * HOUR);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  };
  const row = (number: number, title: string, change: Partial<JobRow>): JobRow => ({
    number,
    title,
    brief: "brief",
    priority: "routine",
    deadline: null,
    template: "research",
    tier: "mid",
    effort: { requested: "medium", applied: "medium" },
    attempts: { raises: 0, restarts: 0 },
    cost: 0.41,
    cap: 1,
    status: "done",
    owner: "owner",
    conversationId: null as unknown as ConversationId,
    taskId: null as unknown as TaskId,
    turn: null,
    createdAt: NOW - 3 * HOUR,
    endedAt: NOW - HOUR,
    result: null,
    ...emptyJobExtras(),
    ...change,
  });
  const failure = (text: string) => ({
    kind: "failure" as const,
    text,
    at: NOW - HOUR,
    pulledAt: NOW - HOUR,
    wokeAt: null,
  });
  const question = {
    number: 1,
    from: "job" as const,
    text: "Which address goes on the form?",
    askedAt: NOW - HOUR,
    toPerson: true,
    personAskedAt: NOW - HOUR,
    answer: null,
    answeredAt: null,
    answeredBy: null,
  };

  it("prints every reason line as the approved text writes it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { setup, harness } = await openOwner();
    const stoppedAt = at(14, 20);
    const rows = [
      row(12, "compare broadband deals", {
        status: "paused",
        endedAt: null,
        pause: { reason: "cap", at: NOW, detail: "" },
        cost: 1,
      }),
      row(13, "tidy the photo folders", {
        status: "paused",
        endedAt: null,
        pause: { reason: "loop", at: NOW, detail: "" },
      }),
      row(11, "renew passport form", {
        status: "waiting",
        endedAt: null,
        priority: "deadline",
        deadline: "2026-10-20",
        question,
      }),
      row(8, "school trip costs", {
        status: "failed",
        result: failure("raise and restart used"),
        attempts: { raises: 0, restarts: 1 },
      }),
      row(14, "flights to Lisbon in May", {
        status: "stopped",
        stop: { at: stoppedAt, by: "person" },
      }),
      row(6, "cheap hotels in Porto", {
        status: "rejected",
        review: {
          status: "rejected",
          model: "m",
          reason: "the prices are not for the brief's dates",
          conversationId: null,
          at: NOW,
        },
      }),
      row(7, "compare gym prices", {
        status: "blocked",
        result: failure("blocked"),
        block: { cause: "hit", kind: "page", tool: "read_fixture_page", chunk: 1, at: NOW },
      }),
      row(5, "read the school letter", {
        status: "blocked",
        result: failure("blocked"),
        block: { cause: "timeout", kind: "file", tool: "read_file", chunk: null, at: NOW },
      }),
      row(9, "bin day check", { status: "done" }),
    ];
    await harness.harness.commit(async (tx) => {
      const board = await tx.doc(JobBoardDoc);
      board.nextNumber = 15;
      for (const each of rows) board.jobs[String(each.number)] = each;
      board.queue = [11, 12, 13, 6];
    }, BACKGROUND_CONTEXT);

    const ran = await secbot(setup, "jobs");
    await evidence("ac-5-board", ran);
    expect(ran.code).toBe(0);
    fits(ran.out);
    const lines = ran.out.split("\n");
    expect(lines[0]).toBe("JOBS  owner  [ live: 4 ] [ results waiting: 0 ]  [ shadow ]");
    for (const reason of [
      "cap reached; the lead asks you before going on",
      "same step failed 3 times; the lead decides what next",
      'asks you: "Which address goes on the form?"  /answer 11 <text>',
      "raise and restart used; the lead asked you",
      `stopped by you at ${new Date(stoppedAt).toISOString().slice(11, 16)}; secbot jobs restart 14`,
      "review rejected: the prices are not for the brief's dates",
      "a page tried to give the agent orders; nothing from it was used",
      "the content check did not answer; stopped to be safe",
    ]) {
      expect(lines).toContain(`      ${reason}`);
    }
    expect(lines).toContain("FINISHED (last 24 h)");
    expect(lines).toContain(
      "11  renew passport form       due 20 Oct  mid/med    0+0  $0.41/$1   waiting",
    );
    expect(lines.at(-2)).toBe("showing 9; older jobs: secbot activity");
  }, 60_000);
});
