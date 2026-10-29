// Stopping and restarting a shared job, end to end on two fleets: the worker's routes, the real
// `owner` and `second` person cells, and the real household cell with the faux model. One
// person's `secbot stop` halts the shared job on both boards and leaves the other person's own
// job running; the other person restarts it by number, and the household resumes it from its kept
// brief and transcript; the owner's `secbot stop --all` counts it under the household. With
// SECBOT_EVIDENCE_DIR set, each command's output is written there.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { StopDoc } from "@secbot/cell-harness";
import { until } from "@secbot/cell-harness/testing";
import { createHold, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatSession,
  evidence,
  fitsTerminal,
  householdHarness,
  householdRow,
  proposeShared,
  type SharedSetup,
  sharedSetup,
} from "./shared-setup.ts";

let s: SharedSetup | undefined;
let hold: ReturnType<typeof createHold> | undefined;
afterEach(async () => {
  for (const role of ["household", "research"]) hold?.release(role);
  hold = undefined;
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const TITLE = "plan the May trip";
const STOPPED = /^ {6}stopped by .+ at \d\d:\d\d; secbot jobs restart 1$/m;

describe("a shared job's stop and restart, end to end", () => {
  it("stops on both boards from one person, restarts from the other, and counts in the owner's stop", {
    timeout: 60_000,
  }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hold = createHold();
    const holding = hold;
    s = await sharedSetup({ fleets: 2, wrap: hold.wrap });
    const setup = s;
    for (const person of ["owner", "second"]) {
      expect((await setup.secbotAs(person, ["jobs"])).code).toBe(0);
    }
    const owner = chatSession(setup, "owner");
    const second = chatSession(setup, "second");
    await owner.open();
    await second.open();
    const household = await householdHarness(setup);
    const householdStopping = async () =>
      (await household.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null;

    // A joined shared job held running in the household, and the owner's own job held running.
    holding.hold("household");
    await proposeShared(setup, owner, second, TITLE, 1);
    await second.say("/join 1");
    await until(() => holding.waiting("household") === 1);
    holding.hold("research");
    await (
      await setup
        .harness("owner")
        .submit(
          startJobLine({ title: "owner's flights", brief: "find flights", template: "research" }),
          "own-job",
        )
    ).wait(BACKGROUND_CONTEXT);
    await until(() => holding.waiting("research") === 1);
    await setup.harness("owner").syncShared();
    await setup.harness("second").syncShared();

    // The second person's stop halts the shared job; the household's stop waits for its held
    // model step, so the hold opens once the stop runs and closes again for the restart.
    const stopping = setup.secbotAs("second", ["stop"]);
    await until(householdStopping);
    holding.release("household");
    const stopped = await stopping;
    holding.hold("household");
    await evidence("shared-stop-second", stopped);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toMatch(/^\[ stopped \] 1 job/);
    for (const person of ["owner", "second"]) await setup.harness(person).syncShared();
    const boards = {
      owner: await setup.secbotAs("owner", ["jobs"]),
      second: await setup.secbotAs("second", ["jobs"]),
    };
    await evidence("shared-stop-boards", {
      code: 0,
      out: `${boards.owner.out}\n${boards.second.out}`,
      err: `${boards.owner.err}${boards.second.err}`,
    });
    for (const board of [boards.owner, boards.second]) {
      expect(board.out).toMatch(/^1 {3}plan the May trip .*stopped$/m);
      expect(board.out).toMatch(STOPPED);
      expect(fitsTerminal(board.out)).toBe(true);
    }
    expect(boards.owner.out).toMatch(/^2 {3}owner's flights .*running$/m);
    expect((await setup.harness("owner").board()).jobs["2"]?.status).toBe("running");

    // The owner restarts it by number: the household resumes it from its kept brief and
    // transcript, in a new run.
    const before = await householdRow(setup, 1);
    const restarted = await setup.secbotAs("owner", ["jobs", "restart", "1"]);
    await evidence("shared-restart-owner", restarted);
    expect(restarted).toMatchObject({
      code: 0,
      out: `[ restarted ] #1 ${TITLE}, from its kept brief and transcript\n`,
    });
    await until(() => holding.waiting("household") === 1);
    const after = await householdRow(setup, 1);
    expect(after?.status).toBe("running");
    expect(after?.brief).toBe(before?.brief);
    expect(after?.runs.length).toBe((before?.runs.length ?? 0) + 1);
    expect((await setup.harness("owner").board()).jobs["1"]?.taskId ?? null).toBeNull();
    for (const person of ["owner", "second"]) {
      await setup.harness(person).syncShared();
      expect((await setup.harness(person).board()).jobs["1"]?.status).toBe("running");
    }

    // The owner's stop of the whole household counts the shared job under the household.
    const all = setup.secbotAs("owner", ["stop", "--all"], { operator: true });
    await until(
      async () =>
        (await setup.harness("owner").harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active !=
        null,
    );
    holding.release("research");
    await until(householdStopping);
    holding.release("household");
    const ran = await all;
    await evidence("shared-stop-all", ran);
    expect(ran.code).toBe(0);
    // The shared job is counted once, under the household; each person counts only their own.
    expect(ran.out).toBe(
      "[ stopped ] household: 2 jobs and 0 lead turns. Their state is kept.\n  owner     1 job\n  second    0 jobs\n  household 1 shared job\n",
    );
    expect(fitsTerminal(ran.out)).toBe(true);
    await owner.close();
    await second.close();
  });
});
