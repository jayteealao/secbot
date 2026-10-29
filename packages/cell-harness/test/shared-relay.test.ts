// The person side of shared jobs, against a real household agent: the outbox goes out and is
// cleared by its acks, an offer becomes a row, status and result are mirrored once, a lost answer
// is sent again with the same operation id, a decline ends the requesting row, notices reach the
// lead once, and each charge is booked once on the person's month.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openCelldStorageWithDatabase } from "@secbot/cell-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc, type JobRow } from "../src/docs.ts";
import { type HouseholdAgent, openHouseholdAgent } from "../src/household-agent.ts";
import type { HouseholdClient, SharedSyncRequest } from "../src/household-contract.ts";
import { createSharedRow } from "../src/job-board.ts";
import { readMonth } from "../src/month-ledger.ts";
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
  until,
} from "./fixtures.ts";
import { wakeNoticesOf } from "./job-helpers.ts";

const open: { agent?: HouseholdAgent | undefined; cells: TestCell[] } = { cells: [] };
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
}

export async function openPair(
  respond: Responder = () => fauxAssistantMessage([fauxText("Plan for both: the coast.")]),
  stepCostUsd?: (modelId: string) => number,
): Promise<SharedPair> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const clock = { now: Date.now() };
  const gateway = createFauxGateway(
    resultReviewer(respond),
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
    budgets: async () => [],
    household: createHouseholdStub(),
    persons: ["owner", "second"],
  });
  open.agent = agent;
  const requests: SharedSyncRequest[] = [];
  const drop = { owner: false, second: false };
  const clientOf = (who: "owner" | "second"): HouseholdClient => ({
    ...createHouseholdStub(),
    sharedSync: async (request) => {
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
  const owner = await openTestCell({
    person: "owner",
    household: clients.owner,
    now: () => clock.now,
  });
  const second = await openTestCell({
    person: "second",
    household: clients.second,
    now: () => clock.now,
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
        syncedAt: null,
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

describe("the person side's reconcile", () => {
  it("sends a proposal, clears it on its ack, and stores the household number", async () => {
    const pair = await openPair();
    const n = await proposeFrom(pair);
    expect(await pair.sync("owner")).toMatchObject({ outcome: "ok", ops: 1 });
    expect((await pair.row("owner", n))?.shared).toMatchObject({
      household: 1,
      consent: "asked",
      outbox: [],
    });
    expect((await pair.row("owner", n))?.status).toBe("waiting");
  });

  it("turns an offer into a waiting row on the other board, and mirrors the job and its result once", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    await pair.sync("owner");
    await pair.sync("second");
    const offered = await pair.row("second", 1);
    expect(offered).toMatchObject({
      status: "waiting",
      template: "household",
      title: "plan the May trip",
    });
    expect(offered?.shared).toMatchObject({
      role: "other",
      with: "owner",
      consent: "offered",
      household: 1,
    });
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    expect(pair.requests.at(-1)?.ops.map((op) => op.kind)).toEqual(["answer"]);
    await until(async () => {
      await pair.sync("owner");
      return (await pair.row("owner", 1))?.status === "done";
    });
    const done = await pair.row("owner", 1);
    expect(done?.result).toMatchObject({ kind: "routine", text: "Plan for both: the coast." });
    const at = done?.result?.at;
    await pair.sync("owner");
    expect((await pair.row("owner", 1))?.result?.at).toBe(at);
    await pair.sync("second");
    expect((await pair.row("second", 1))?.result?.text).toBe("Plan for both: the coast.");
  });

  it("sends a lost answer again with the same operation id, and the household applies it once", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    pair.dropNext("owner");
    expect((await pair.sync("owner")).outcome).toBe("failed");
    expect((await pair.row("owner", 1))?.shared?.outbox).toHaveLength(1);
    await pair.sync("owner");
    const [first, second] = pair.requests.map((request) => request.ops[0]?.opId);
    expect(first).toBe(second);
    expect((await pair.row("owner", 1))?.shared).toMatchObject({ household: 1, outbox: [] });
    const rows = (await pair.agent.exchange({ person: "owner", ops: [] })).rows;
    expect(rows).toHaveLength(1);
  });

  it("ends the requesting row failed with the decline text, and the offer row too", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    await pair.sync("owner");
    await pair.sync("second");
    await answerFrom(pair, 1, false);
    await pair.sync("second");
    await pair.sync("owner");
    expect(await pair.row("owner", 1)).toMatchObject({
      status: "failed",
      result: { kind: "failure", text: "second declined to share the cost" },
    });
    expect((await pair.row("second", 1))?.shared?.consent).toBe("declined");
    expect((await pair.row("second", 1))?.status).toBe("failed");
  });
});

describe("notices to the lead", () => {
  const notices = (cell: TestCell) => wakeNoticesOf(cell.cell.root);

  it("wakes the other lead with the offer, and the requesting lead with the join line, once each", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    await pair.sync("owner");
    const offered = await pair.sync("second");
    expect(offered).toMatchObject({
      notices: [
        {
          job: 1,
          requestId: "shared:1:offer",
          text: "[job 1 shared offer from owner: plan the May trip; the person's half is about $0.13. Call offer_shared with job 1, then ask the person in your own words whether to share the cost]",
        },
      ],
    });
    await until(async () => (await notices(pair.second)).length === 1);
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    const joined = await pair.sync("owner");
    expect(joined).toMatchObject({
      notices: [
        {
          requestId: "shared:1:joined",
          text: "[job 1 shared: second agreed to share the cost. Tell the person in one line: On it, for both of you: plan the May trip (job 1, household, shared)]",
        },
      ],
    });
    const again = await pair.sync("second");
    expect(again).toMatchObject({ notices: [] });
    await until(async () => (await notices(pair.owner)).length === 1);
  });

  it("wakes the requesting lead with a failure on a decline", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    await pair.sync("owner");
    await pair.sync("second");
    await answerFrom(pair, 1, false);
    await pair.sync("second");
    expect(await pair.sync("owner")).toMatchObject({
      notices: [{ requestId: "wake:1:failure", text: "[job 1 failure: pull it with job_result]" }],
    });
    expect((await pair.sync("owner")) as { notices: unknown[] }).toMatchObject({ notices: [] });
    expect((await pair.row("owner", 1))?.result?.wokeAt).not.toBeNull();
  });

  it("sends the late notice for a routine result unpulled for 30 minutes, once", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    await pair.sync("owner");
    await pair.sync("second");
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    await until(async () => {
      await pair.sync("owner");
      return (await pair.row("owner", 1))?.result !== null;
    });
    expect((await pair.sync("owner")) as { notices: unknown[] }).toMatchObject({ notices: [] });
    pair.clock.now += 30 * 60_000;
    expect(await pair.sync("owner")).toMatchObject({
      notices: [
        { requestId: "wake:1:late", text: "[job 1 waited 30 minutes: pull it with job_result]" },
      ],
    });
    expect((await pair.sync("owner")) as { notices: unknown[] }).toMatchObject({ notices: [] });
  });
});

describe("charges on the person's month", () => {
  it("books each person's half under household, once, also when an answer is lost and sent again", async () => {
    const pair = await openPair(undefined, () => 0.1);
    await proposeFrom(pair);
    await pair.sync("owner");
    await pair.sync("second");
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    await until(
      async () =>
        (await pair.agent.exchange({ person: "owner", ops: [] })).rows[0]?.status === "done",
    );
    pair.dropNext("owner");
    expect((await pair.sync("owner")).outcome).toBe("failed");
    await pair.sync("owner");
    await pair.sync("owner");
    await pair.sync("second");
    const owner = await readMonth(
      pair.owner.cell.harness,
      pair.clock.now,
      "UTC",
      BACKGROUND_CONTEXT,
    );
    const second = await readMonth(
      pair.second.cell.harness,
      pair.clock.now,
      "UTC",
      BACKGROUND_CONTEXT,
    );
    expect(owner.person.byRole.household).toBeCloseTo(0.05, 6);
    expect(second.person.byRole.household).toBeCloseTo(0.05, 6);
    expect((await pair.row("owner", 1))?.shared?.charges).toEqual(["shared:1:1:owner"]);
  });
});
