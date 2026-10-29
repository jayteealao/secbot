// A running shared job on both boards, end to end on one fleet and on two: the worker's routes,
// the real `owner` and `second` person cells, and the real household cell with the faux model.
// `secbot jobs` shows the job as shared on each person's board, and the owner's `--household` view
// lists it; once it finishes, each person's lead pulls the result and relays it in its own words,
// and the result enters each lead conversation only through that pull. The household's own
// outbound calls are its model calls only. With SECBOT_EVIDENCE_DIR set, each output is written
// there.
import { until } from "@secbot/cell-harness/testing";
import { createHold } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entriesOf, entryRole, entryText } from "../../cell-harness/test/job-helpers.ts";
import {
  chatSession,
  evidence,
  evidenceJson,
  fitsTerminal,
  HOUSEHOLD_PLAN,
  householdRow,
  proposeShared,
  relayText,
  type SharedSetup,
  sharedSetup,
} from "./shared-setup.ts";

let s: SharedSetup | undefined;
let hold: ReturnType<typeof createHold> | undefined;
afterEach(async () => {
  hold?.release("household");
  hold = undefined;
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const TITLE = "plan the May trip";

/** The shared row and its line, as the approved board prints them (cost against the cap). */
const sharedRow = (cost: string, other: string) =>
  `1   ${TITLE.padEnd(26)}routine     cheap/med  0+0  ${`${cost}/.25`.padEnd(11)}running\n      shared with ${other}; you pay half\n`;

describe.each([1, 2] as const)("a shared job on both boards, %i fleet(s) (AC-33)", (fleets) => {
  it("shows on both boards and reaches each person only through their lead", {
    timeout: 60_000,
  }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hold = createHold();
    s = await sharedSetup({ fleets, wrap: hold.wrap });
    const setup = s;
    for (const person of ["owner", "second"]) {
      expect((await setup.secbotAs(person, ["jobs"])).code).toBe(0);
    }
    const owner = chatSession(setup, "owner");
    const second = chatSession(setup, "second");
    await owner.open();
    await second.open();

    // The household job is held at its first model step, so it is running on both boards.
    hold.hold("household");
    await proposeShared(setup, owner, second, TITLE, 1);
    await second.say("/join 1");
    await until(() => hold?.waiting("household") === 1);
    await setup.harness("owner").syncShared();
    await setup.harness("second").syncShared();

    const cost = `$${(await householdRow(setup, 1))?.cost.toFixed(2)}`;
    const boards = {
      owner: await setup.secbotAs("owner", ["jobs"]),
      second: await setup.secbotAs("second", ["jobs"]),
    };
    for (const [person, other] of [
      ["owner", "second"],
      ["second", "owner"],
    ] as const) {
      const board = boards[person];
      await evidence(`ac-33-board-${person}-${fleets}`, board);
      expect(board.code).toBe(0);
      expect(board.err).toBe("");
      expect(board.out).toContain(sharedRow(cost, other));
      expect(fitsTerminal(board.out)).toBe(true);
    }
    const household = await setup.secbotAs("owner", ["jobs", "--household"], { operator: true });
    await evidence(`ac-33-household-${fleets}`, household);
    expect(household.code).toBe(0);
    expect(household.out).toMatch(/^1 {3}plan the May trip {9}routine {5}cheap\/med .*running$/m);
    expect(fitsTerminal(household.out)).toBe(true);

    // The job finishes; each person's lead pulls the result and relays it.
    hold.release("household");
    await until(async () => (await householdRow(setup, 1))?.status === "done");
    for (const person of ["owner", "second"]) {
      await setup.harness(person).syncShared();
      await until(
        async () =>
          (await setup.harness(person).board()).jobs["1"]?.result?.text === HOUSEHOLD_PLAN,
      );
    }
    const relay: Record<string, unknown> = {};
    for (const [person, chat] of [
      ["owner", owner],
      ["second", second],
    ] as const) {
      await chat.say('CALL job_result {"job":1}');
      await until(() => chat.out().includes(relayText(HOUSEHOLD_PLAN)));
      // The plan enters the lead conversation only as the pulled result and the lead's own words.
      const holding = (await entriesOf(setup.harness(person).root))
        .filter((entry) => entryText(entry).includes(HOUSEHOLD_PLAN))
        .map((entry) => ({ role: entryRole(entry), text: entryText(entry) }));
      expect(holding.map((entry) => entry.role)).toEqual(["toolResult", "assistant"]);
      expect(holding[1]?.text).toBe(relayText(HOUSEHOLD_PLAN));
      relay[person] = holding;
    }

    // The household's own calls: model calls to the gateway, and nothing to a person or a route.
    const reachesPeople = setup.householdFetches.filter((url) =>
      /\/v1\/cells\/|\/session|\/internal\/|owner|second/.test(url),
    );
    expect(reachesPeople).toEqual([]);
    const householdRequests = setup.gateway.requests.filter(
      (request) => request.role === "household",
    );
    expect(householdRequests.length).toBeGreaterThan(0);
    await evidenceJson(`ac-33-relay-${fleets}.json`, {
      leadEntriesHoldingTheResult: relay,
      householdFetches: setup.householdFetches,
      householdModelRequests: householdRequests.map((request) => ({
        role: request.role,
        model: request.modelId,
      })),
    });
    await owner.close();
    await second.close();
  });
});
