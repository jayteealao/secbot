// `secbot stop` and `secbot jobs restart` against the worker's routes and a real person cell on
// the stand-in with the faux model, run in process with no TTY. Two research jobs run (held by the
// model), the lead is mid-turn, and a reminder and the heartbeat routine are set: the stop ends
// both jobs and the lead's turn and keeps the reminder and the routine on their schedule (AC-29);
// the board shows both jobs stopped by the person; a restart resumes job 1 from its kept brief and
// transcript, and a paused job and a missing number print their lines (AC-30). With
// SECBOT_EVIDENCE_DIR set, each command's output and job 1's transcript are written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CellHarness, JobBoardDoc, StopDoc } from "@secbot/cell-harness";
import { until } from "@secbot/cell-harness/testing";
import { createHold, jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entriesOf, entryRole, entryText } from "../../cell-harness/test/job-helpers.ts";
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

/** Runs `secbot <argv>` in process against the worker as the owner's laptop. */
async function secbot(setup: GuardSetup, ...argv: string[]) {
  dir ??= await mkdtemp(join(tmpdir(), "secbot-stop-cli-"));
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

/** Writes `<name>.stdout.txt`, `.stderr.txt`, and `.exit-code` when evidence is asked for. */
async function evidence(name: string, ran: { code: number; out: string; err: string }) {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(join(where, `${name}.stdout.txt`), ran.out);
  await writeFile(join(where, `${name}.stderr.txt`), ran.err);
  await writeFile(join(where, `${name}.exit-code`), `${ran.code}\n`);
}

async function evidenceJson(name: string, value: unknown) {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(join(where, name), `${JSON.stringify(value, null, 2)}\n`);
}

const row = async (harness: CellHarness, n: number) => (await harness.board()).jobs[String(n)];

/** The reminder and routine wake times, by source (the jobs' own wakes aside). */
const timers = async (harness: CellHarness) =>
  Object.fromEntries(
    (await harness.wakes()).summary.wakes
      .filter((wake) => wake.source === "reminder" || wake.source === "heartbeat")
      .map((wake) => [wake.source, wake.at]),
  );

const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

describe("secbot stop and secbot jobs restart (AC-29, AC-30)", () => {
  it("stops the jobs and the lead's turn, keeps the schedule, and restarts one job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hold = createHold();
    const held = hold;
    s = await guardSetup(undefined, { respond: held.wrap(jobResponder) });
    const setup = s;
    const opened = await route(
      new Request(`http://${HOST}/v1/cells/owner/status`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
      setup.env,
    );
    expect(opened.status).toBe(200);
    const harness = setup.harness("owner");
    const lead = async (text: string, id: string) =>
      (await harness.submit(text, id)).wait(BACKGROUND_CONTEXT);

    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    await lead(`CALL set_reminder ${JSON.stringify({ at, text: "check the oven" })}`, "remind");
    held.hold("research");
    await lead(
      startJobLine({ title: "flights to Lisbon", brief: "find flights", template: "research" }),
      "job-1",
    );
    await lead(
      startJobLine({ title: "train times", brief: "find trains", template: "research" }),
      "job-2",
    );
    await until(() => held.waiting("research") === 2);
    held.hold("lead");
    void harness.submit("what is the weather like?", "busy");
    await until(() => held.waiting("lead") === 1);
    const before = await timers(harness);
    expect(Object.keys(before).sort()).toEqual(["heartbeat", "reminder"]);

    // The stop: the faux model sees the abort when its held step answers.
    const stopping = secbot(setup, "stop");
    await until(
      async () => (await harness.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
    );
    held.release("research");
    held.release("lead");
    const stopped = await stopping;
    await evidence("ac-29-stop", stopped);
    expect(stopped).toEqual({
      code: 0,
      out: [
        "[ stopped ] 2 jobs and the lead's current turn. Their state is kept.",
        "  Routines and reminders keep their schedule.",
        "  Restart one: secbot jobs restart <#>",
        "",
      ].join("\n"),
      err: "",
    });
    expect(await timers(harness)).toEqual(before);

    const board = await secbot(setup, "jobs");
    await evidence("ac-29-board", board);
    expect(board.code).toBe(0);
    for (const n of [1, 2]) {
      const job = await row(harness, n);
      expect(job).toMatchObject({ status: "stopped", stop: { by: "person" } });
      const line = `      stopped by you at ${hhmm(job?.stop?.at ?? 0)}; secbot jobs restart ${n}`;
      expect(board.out.split("\n")).toContain(line);
    }
    expect(board.out.split("\n").filter((line) => /^[12] {2}/.test(line))).toHaveLength(2);

    // The restart: job 1 forks its stopped run and gets one resume line.
    const old = (await row(harness, 1))?.conversationId;
    if (old === null || old === undefined) throw new Error("job 1 has no run");
    const oldConversation = await harness.harness.conversation(old, BACKGROUND_CONTEXT);
    if (oldConversation === undefined) throw new Error("no stopped run");
    const oldIds = (await entriesOf(oldConversation)).map((entry) => String(entry.id));
    held.hold("research");
    const restarted = await secbot(setup, "jobs", "restart", "1");
    await evidence("ac-30-restart", restarted);
    expect(restarted).toEqual({
      code: 0,
      out: "[ restarted ] #1 flights to Lisbon, from its kept brief and transcript\n",
      err: "",
    });
    await until(() => held.waiting("research") === 1);
    expect((await row(harness, 1))?.status).toBe("running");
    const id = (await row(harness, 1))?.conversationId;
    if (id === null || id === undefined) throw new Error("job 1 did not resume");
    const fork = await harness.harness.conversation(id, BACKGROUND_CONTEXT);
    if (fork === undefined) throw new Error("no resumed run");
    const entries = await entriesOf(fork);
    expect(entries.slice(0, oldIds.length).map((entry) => String(entry.id))).toEqual(oldIds);
    const resumeLine = entries[oldIds.length];
    expect(resumeLine === undefined ? "" : entryRole(resumeLine)).toBe("user");
    expect(resumeLine === undefined ? "" : entryText(resumeLine)).toMatch(
      /^The person stopped this job at \d\d:\d\d; it is resumed now\./,
    );
    await evidenceJson(
      "ac-30-entries.json",
      entries.map((entry) => ({
        id: String(entry.id),
        role: entryRole(entry),
        text: entryText(entry),
      })),
    );
    held.release("research");
    await until(async () => (await row(harness, 1))?.status === "done");

    // A paused job is the lead's; a missing number is named.
    await harness.harness.commit(async (tx) => {
      const job = (await tx.doc(JobBoardDoc)).jobs["2"];
      if (job === undefined) throw new Error("no job 2");
      job.status = "paused";
      job.pause = { reason: "loop", at: Date.now(), detail: "" };
    }, BACKGROUND_CONTEXT);
    const paused = await secbot(setup, "jobs", "restart", "2");
    await evidence("ac-30-restart-paused", paused);
    expect(paused).toEqual({
      code: 1,
      out: "[ restarted ] #2 train times is paused, not stopped; ask the lead\n",
      err: "",
    });
    const missing = await secbot(setup, "jobs", "restart", "22");
    await evidence("ac-30-restart-missing", missing);
    expect(missing).toEqual({ code: 1, out: "", err: "no stopped job #22\n" });
  }, 60_000);
});
