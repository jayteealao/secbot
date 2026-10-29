// `secbot stop --all` across two fleets, run in process with no TTY: fleet A serves the owner's
// cell and reaches fleet B (the second person's cell and the household cell) at its private
// address; a job runs in each person cell. The owner's stop with the operator key stops every cell
// and prints each with its count, and both jobs are stopped by the owner (AC-31, stand-in half).
// When fleet B does not answer, stderr names its cells with exit code 1, and the owner's cell is
// still stopped. With SECBOT_EVIDENCE_DIR set, each command's output is written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CellHarness, StopDoc } from "@secbot/cell-harness";
import { until } from "@secbot/cell-harness/testing";
import { createHold, jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { PERSON_HEADER } from "../src/person-cell.ts";
import { route } from "../src/routes.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  OPERATOR_KEY,
  workerFetch,
} from "./guard-setup.ts";

const FLEET_B = "http://fleet-b.internal:8080";

const setups: GuardSetup[] = [];
const holds: ReturnType<typeof createHold>[] = [];
let dir: string | undefined;
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release("research");
  for (const setup of setups.splice(0)) await closeAll(setup);
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs `secbot <argv>` in process against fleet A with the operator key. */
async function secbot(fleet: GuardSetup, ...argv: string[]) {
  dir ??= await mkdtemp(join(tmpdir(), "secbot-stop-all-"));
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
  const env = {
    SECBOT_CONFIG_DIR: dir,
    SECBOT_CELL_URL: `http://${HOST}`,
    SECBOT_OPERATOR_KEY: OPERATOR_KEY,
  };
  const code = await run(argv, { environment: { env, home: dir }, io, fetch: workerFetch(fleet) });
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

/** Opens a person cell of a fleet and starts one research job, held at its first step. */
async function runningJob(fleet: GuardSetup, person: string, hold: ReturnType<typeof createHold>) {
  const opened = await fleet.env.PERSON_CELL.get(person).fetch(
    new Request(`http://cell/v1/cells/${person}/status`, { headers: { [PERSON_HEADER]: person } }),
  );
  expect(opened.status).toBe(200);
  const harness = fleet.harness(person);
  hold.hold("research");
  await (
    await harness.submit(
      startJobLine({ title: `${person}'s flights`, brief: "find flights", template: "research" }),
      `${person}-job`,
    )
  ).wait(BACKGROUND_CONTEXT);
  await until(() => hold.waiting("research") === 1);
  return harness;
}

const stopActive = async (harness: CellHarness) =>
  (await harness.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null;

async function twoFleets() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const holdA = createHold();
  const holdB = createHold();
  holds.push(holdA, holdB);
  const a = await guardSetup("owner", { respond: holdA.wrap(jobResponder) });
  const b = await guardSetup("second,household", {
    respond: holdB.wrap(jobResponder),
    household: true,
  });
  setups.push(a, b);
  (a.env as { SECBOT_HOUSEHOLD_URL?: string }).SECBOT_HOUSEHOLD_URL = FLEET_B;
  let refusing = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(FLEET_B)) throw new TypeError(`no route to ${request.url}`);
    if (refusing) return Response.json({ error: "unavailable" }, { status: 503 });
    return route(request, b.env);
  });
  const owner = await runningJob(a, "owner", holdA);
  const second = await runningJob(b, "second", holdB);
  return {
    a,
    owner,
    second,
    holdA,
    holdB,
    refuse: () => {
      refusing = true;
    },
  };
}

describe("secbot stop --all across two fleets (AC-31)", () => {
  it("stops every cell of both fleets and prints each with its count", async () => {
    const { a, owner, second, holdA, holdB } = await twoFleets();
    const stopping = secbot(a, "stop", "--all");
    await until(() => stopActive(owner));
    holdA.release("research");
    await until(() => stopActive(second));
    holdB.release("research");
    const ran = await stopping;
    await evidence("ac-31-stop-all", ran);
    expect(ran).toEqual({
      code: 0,
      out: [
        "[ stopped ] household: 2 jobs and 0 lead turns. Their state is kept.",
        "  owner     1 job",
        "  second    1 job",
        "  household 0 shared jobs",
        "",
      ].join("\n"),
      err: "",
    });
    for (const harness of [owner, second]) {
      expect((await harness.board()).jobs["1"]).toMatchObject({
        status: "stopped",
        stop: { by: "owner" },
      });
    }
  }, 60_000);

  it("names the other fleet's cells when it does not answer, and still stops the owner", async () => {
    const { a, owner, holdA, refuse } = await twoFleets();
    refuse();
    const stopping = secbot(a, "stop", "--all");
    await until(() => stopActive(owner));
    holdA.release("research");
    const ran = await stopping;
    await evidence("ac-31-stop-incomplete", ran);
    expect(ran).toEqual({
      code: 1,
      out: [
        "[ stopped ] household: 1 job and 0 lead turns. Their state is kept.",
        "  owner     1 job",
        "",
      ].join("\n"),
      err: [
        "secbot: stop incomplete: second and household did not answer; owner stopped.",
        "  run secbot stop --all again",
        "",
      ].join("\n"),
    });
    expect((await owner.board()).jobs["1"]).toMatchObject({
      status: "stopped",
      stop: { by: "owner" },
    });
  }, 60_000);
});
