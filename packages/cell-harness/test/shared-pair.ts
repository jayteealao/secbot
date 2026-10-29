// Two real person cells and a real household agent joined by the shared-job exchange, for the
// person-side tests: the owner proposes, the other person answers, and either side syncs.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openCelldStorageWithDatabase } from "@secbot/cell-storage";
import { afterEach, vi } from "vitest";
import { JobBoardDoc, type JobRow } from "../src/docs.ts";
import { type HouseholdAgent, openHouseholdAgent } from "../src/household-agent.ts";
import type { HouseholdClient, SharedSyncRequest } from "../src/household-contract.ts";
import { createSharedRow } from "../src/job-board.ts";
import { type SharedParts, sharedOpId, syncShared } from "../src/shared-relay.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  FakeCelldStorage,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type Responder,
  resultReviewer,
  type TestCell,
} from "./fixtures.ts";
import { jobResponder } from "./responders.ts";

export const open: { agent?: HouseholdAgent | undefined; cells: TestCell[] } = { cells: [] };
afterEach(async () => {
  for (const cell of open.cells.splice(0)) await cell.cell.close();
  await open.agent?.close();
  open.agent = undefined;
  vi.restoreAllMocks();
});

export interface SharedPair {
  readonly agent: HouseholdAgent;
  readonly owner: TestCell;
  readonly second: TestCell;
  readonly parts: (who: "owner" | "second") => SharedParts;
  readonly sync: (who: "owner" | "second") => ReturnType<typeof syncShared>;
  readonly row: (who: "owner" | "second", n: number) => Promise<JobRow | undefined>;
  /** Loses the next answer of `who` after the household applied it. */
  dropNext(who: "owner" | "second"): void;
  readonly requests: SharedSyncRequest[];
  clock: { now: number };
  setDown(value: boolean): void;
}

export async function openPair(
  respond: Responder = () => fauxAssistantMessage([fauxText("Plan for both: the coast.")]),
  stepCostUsd?: (modelId: string) => number,
  /** The persons' newest months, as the household budget board reads them (default none). */
  budgets: () => Promise<
    readonly { cell: string; spentUsd: number; limitUsd: number }[]
  > = async () => [],
): Promise<SharedPair> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const clock = { now: Date.now() };
  const gateway = createFauxGateway(
    resultReviewer((request) =>
      request.role === "lead" ? jobResponder(request) : respond(request),
    ),
    stepCostUsd === undefined ? {} : { stepCostUsd },
  );
  const agent = await openHouseholdAgent({
    cell: "household",
    storage: (await openCelldStorageWithDatabase(new FakeCelldStorage())).storage,
    env: {},
    now: () => clock.now,
    onReport: () => {},
    onWakeChange: () => {},
    models: gateway.models,
    budgets,
    household: createHouseholdStub(),
    persons: ["owner", "second"],
  });
  open.agent = agent;
  const requests: SharedSyncRequest[] = [];
  const drop = { owner: false, second: false };
  const down = { value: false };
  const clientOf = (who: "owner" | "second"): HouseholdClient => ({
    ...createHouseholdStub(),
    sharedSync: async (request) => {
      if (down.value) throw new Error("household unreachable");
      requests.push(request);
      const answer = await agent.exchange(request);
      if (drop[who]) {
        drop[who] = false;
        throw new Error("connection reset after the method started");
      }
      return answer;
    },
  });
  const clients = { owner: clientOf("owner"), second: clientOf("second") };
  const persons = ["owner", "second"];
  const owner = await openTestCell({
    person: "owner",
    household: clients.owner,
    now: () => clock.now,
    persons,
    gateway,
  });
  const second = await openTestCell({
    person: "second",
    household: clients.second,
    now: () => clock.now,
    persons,
    gateway,
  });
  open.cells.push(owner, second);
  const cells = { owner, second };
  const parts = (who: "owner" | "second"): SharedParts => ({
    harness: cells[who].cell.harness,
    person: who,
    household: () => clients[who],
    now: () => clock.now,
  });
  return {
    agent,
    owner,
    second,
    parts,
    sync: (who) => syncShared(parts(who), BACKGROUND_CONTEXT),
    row: async (who, n) =>
      (await cells[who].cell.harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs[String(n)],
    dropNext: (who) => {
      drop[who] = true;
    },
    requests,
    clock,
    setDown: (value) => {
      down.value = value;
    },
  };
}

/** The owner proposes a shared job: a requesting row with a propose op in its outbox. */
export async function proposeFrom(pair: SharedPair, title = "plan the May trip"): Promise<number> {
  return pair.owner.cell.harness.commit(async (tx) => {
    const now = pair.clock.now;
    const row = await createSharedRow(tx, {
      title,
      brief: `Plan ${title} for both of us.`,
      priority: "routine",
      deadline: null,
      tier: "cheap",
      effort: { requested: "medium", applied: "medium" },
      owner: "owner",
      createdAt: now,
      shared: {
        household: null,
        role: "requester",
        with: "second",
        consent: "asking",
        payer: "half",
        estimateUsd: 0.25,
        outbox: [],
        charges: [],
        resultAt: null,
        waitingBudget: false,
      },
    });
    row.status = "waiting";
    row.shared?.outbox.push({
      kind: "propose",
      opId: sharedOpId("owner", now),
      person: "owner",
      other: "second",
      local: row.number,
      title,
      brief: row.brief,
      priority: "routine",
      deadline: null,
      tier: "cheap",
      effort: "medium",
      estimateUsd: 0.25,
    });
    return row.number;
  }, BACKGROUND_CONTEXT);
}

/** The other person answers their offer: an answer op in the offered row's outbox. */
export async function answerFrom(pair: SharedPair, n: number, join: boolean): Promise<void> {
  await pair.second.cell.harness.commit(async (tx) => {
    const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
    const link = row?.shared;
    if (row === undefined || link === null || link === undefined || link.household === null) {
      throw new Error("no offer");
    }
    link.consent = join ? "joined" : "declined";
    link.outbox.push({
      kind: "answer",
      opId: sharedOpId("second", pair.clock.now),
      person: "second",
      household: link.household,
      local: n,
      join,
    });
  }, BACKGROUND_CONTEXT);
}
