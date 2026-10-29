// Who pays for a shared job, end to end on two fleets: the worker's routes, the real `owner` and
// `second` person cells, and the real household cell with the faux model, each model step costing
// money. A finished shared job is booked half on each person's month; when one person's limit is
// reached the other pays all; when both are, the job waits with no spend until a limit is raised.
// A charge is booked once across a cell restart and an exchange whose answer was lost. With
// SECBOT_EVIDENCE_DIR set, each person's `secbot cost` output is written there.
import { until } from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST, KEY } from "./guard-setup.ts";
import {
  type ChatSession,
  chatSession,
  evidence,
  householdRow,
  proposeShared,
  SECOND_KEY,
  type SharedSetup,
  sharedSetup,
} from "./shared-setup.ts";

let s: SharedSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const MICRO = 1_000_000;
const micros = (usd: number) => Math.round(usd * MICRO);

/** A person's cost view through their own cost route, as `secbot cost` reads it. */
async function costOf(setup: SharedSetup, person: string) {
  const response = await setup.fetchFor(person)(`http://${HOST}/v1/cells/${person}/cost`, {
    headers: { authorization: `Bearer ${person === "owner" ? KEY : SECOND_KEY}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { spentUsd: number; byRole: Record<string, number> };
}

const householdSpend = async (setup: SharedSetup, person: string) =>
  (await costOf(setup, person)).byRole.household ?? 0;

async function opened(
  options: { readonly clock?: () => number; readonly payerPollMs?: number } = {},
) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  s = await sharedSetup({ fleets: 2, ...options });
  const setup = s;
  for (const person of ["owner", "second"]) {
    expect((await setup.secbotAs(person, ["jobs"])).code).toBe(0);
  }
  const owner = chatSession(setup, "owner");
  const second = chatSession(setup, "second");
  await owner.open();
  await second.open();
  return { setup, owner, second };
}

/** Runs both persons' exchanges until each has booked what the household charged them. */
async function settled(setup: SharedSetup, n: number) {
  await until(async () => (await householdRow(setup, n))?.status === "done");
  for (let round = 0; round < 3; round++) {
    await setup.harness("owner").syncShared();
    await setup.harness("second").syncShared();
  }
}

async function shareAndJoin(
  setup: SharedSetup,
  owner: ChatSession,
  second: ChatSession,
  title: string,
  n: number,
) {
  await proposeShared(setup, owner, second, title, n);
  await second.say(`/join ${n}`);
  await until(async () => (await householdRow(setup, n))?.taskId != null);
}

describe("who pays for a shared job, end to end (AC-34)", () => {
  it("books half on each person's month, once across a restart and a lost answer", {
    timeout: 60_000,
  }, async () => {
    const { setup, owner, second } = await opened();
    await shareAndJoin(setup, owner, second, "plan the May trip", 1);
    await until(async () => (await householdRow(setup, 1))?.status === "done");
    // The owner's first exchange after the job settles is lost after the household applied it.
    const sent = setup.crossFleetSyncs.length;
    setup.dropNextAnswer("owner");
    await until(async () => {
      await setup.harness("owner").syncShared();
      return setup.crossFleetSyncs.slice(sent).some((sync) => sync.status === 503);
    });
    await settled(setup, 1);
    const cost = (await householdRow(setup, 1))?.cost ?? 0;
    expect(cost).toBeGreaterThan(0);
    const halves = {
      owner: await householdSpend(setup, "owner"),
      second: await householdSpend(setup, "second"),
    };
    expect(micros(halves.owner) + micros(halves.second)).toBe(micros(cost));
    expect(Math.abs(micros(halves.owner) - micros(halves.second))).toBeLessThanOrEqual(1);
    for (const person of ["owner", "second"]) {
      const ran = await setup.secbotAs(person, ["cost"]);
      expect(ran.code).toBe(0);
      await evidence(`ac-34-halves-${person}`, ran);
    }

    // Booked once: a restarted cell and more exchanges do not move the month.
    const before = await costOf(setup, "owner");
    await setup.restart("owner");
    expect((await setup.secbotAs("owner", ["jobs"])).code).toBe(0);
    await setup.harness("owner").syncShared();
    await setup.harness("owner").syncShared();
    const after = await costOf(setup, "owner");
    expect(micros(after.byRole.household ?? 0)).toBe(micros(before.byRole.household ?? 0));
  });

  it("makes the other person pay all when one limit is reached", { timeout: 60_000 }, async () => {
    const { setup, owner, second } = await opened();
    await setup.budgetOver("second");
    await shareAndJoin(setup, owner, second, "fix the fence", 1);
    await settled(setup, 1);
    const cost = (await householdRow(setup, 1))?.cost ?? 0;
    expect(cost).toBeGreaterThan(0);
    expect(micros(await householdSpend(setup, "owner"))).toBe(micros(cost));
    expect(await householdSpend(setup, "second")).toBe(0);
    for (const person of ["owner", "second"]) {
      await evidence(`ac-34-other-pays-${person}`, await setup.secbotAs(person, ["cost"]));
    }
  });

  it("holds the job with no spend while both limits are reached", { timeout: 60_000 }, async () => {
    const { setup, owner, second } = await opened({ payerPollMs: 100 });
    // Both limits are reached after the offer and before the answer, so the job never starts.
    await proposeShared(setup, owner, second, "paint the hall", 1);
    await setup.budgetOver("owner");
    await setup.budgetOver("second");
    await second.say("/join 1");
    await until(async () => {
      await setup.harness("owner").syncShared();
      await setup.harness("second").syncShared();
      return (await setup.harness("second").board()).jobs["1"]?.shared?.waitingBudget === true;
    });
    expect(setup.gateway.requests.filter((request) => request.role === "household")).toEqual([]);
    for (const person of ["owner", "second"]) {
      const board = await setup.secbotAs(person, ["jobs"]);
      await evidence(`ac-34-both-over-${person}`, board);
      expect(board.out).toMatch(/^1 {3}paint the hall .*waiting$/m);
      expect(board.out).toMatch(
        /^ {6}over your monthly limit; waits for the owner or \d+ [A-Z][a-z]{2}$/m,
      );
    }
    expect(await householdSpend(setup, "owner")).toBe(0);
    expect(await householdSpend(setup, "second")).toBe(0);

    await setup.budgetBack("owner");
    await until(async () => {
      await setup.harness("owner").syncShared();
      return setup.gateway.requests.some((request) => request.role === "household");
    });
    await settled(setup, 1);
    const cost = (await householdRow(setup, 1))?.cost ?? 0;
    expect(micros(await householdSpend(setup, "owner"))).toBe(micros(cost));
    expect(await householdSpend(setup, "second")).toBe(0);
  });
});

describe("a shared offer nobody answers (edge case)", () => {
  it("waits on both boards for 48 hours with no spend and no household work", {
    timeout: 60_000,
  }, async () => {
    let now = Date.now();
    const { setup, owner, second } = await opened({ clock: () => now });
    await proposeShared(setup, owner, second, "plan the May trip", 1);
    // The routine's work, every 2 hours for 48 hours: each person's exchange and alarm.
    for (let step = 0; step < 24; step++) {
      now += 2 * 60 * 60 * 1000;
      for (const person of ["owner", "second"]) {
        await setup.harness(person).syncShared();
        await setup.cells.get(person)?.alarm();
      }
    }
    const boards = {
      owner: await setup.secbotAs("owner", ["jobs"]),
      second: await setup.secbotAs("second", ["jobs"]),
    };
    await evidence("edge-unanswered-owner", boards.owner);
    await evidence("edge-unanswered-second", boards.second);
    expect(boards.owner.out).toMatch(/^1 {3}plan the May trip .*waiting$/m);
    expect(boards.owner.out).toContain("\n      waiting for second to agree to share the cost\n");
    expect(boards.second.out).toMatch(/^1 {3}plan the May trip .*waiting$/m);
    expect(boards.second.out).toContain("\n      waiting for you to agree to share the cost\n");
    expect(await householdSpend(setup, "owner")).toBe(0);
    expect(await householdSpend(setup, "second")).toBe(0);
    const row = await householdRow(setup, 1);
    expect(row?.taskId ?? null).toBeNull();
    expect(row?.conversationId ?? null).toBeNull();
    expect(setup.gateway.requests.filter((request) => request.role === "household")).toEqual([]);
  });
});
