// The household's shared store: each operation from a person cell applies once by its operation
// id; only the other person's yes starts the job; a decline ends it; restart, resume, and stop
// follow who may do them.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc } from "../src/docs.ts";
import {
  applyOps,
  effectsDone,
  exchange,
  rowsFor,
  SHARED_OPS_KEEP_MS,
  SharedJobsDoc,
  settle,
} from "../src/shared-jobs.ts";
import { type Responder, until } from "./fixtures.ts";
import { createHold } from "./responders.ts";
import {
  answer,
  type HouseholdStandIn,
  openHouseholdStandIn,
  plans,
  propose,
} from "./shared-helpers.ts";

let house: HouseholdStandIn | undefined;
afterEach(async () => {
  await house?.close();
  house = undefined;
  vi.restoreAllMocks();
});

async function open(respond?: Responder) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  house = await openHouseholdStandIn(respond);
  const h = house;
  const apply = (person: string, ...ops: Parameters<typeof applyOps>[2]) =>
    h.commit((tx) => applyOps(tx, person, ops, { task: h.task, now: Date.now() }));
  const shared = () =>
    h.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(SharedJobsDoc))));
  return { h, apply, shared };
}

describe("shared operations in the household", () => {
  it("takes a proposal as a queued household row with no task, waiting for the other person", async () => {
    const { h, apply, shared } = await open();
    const applied = await apply("owner", propose());
    expect(applied.acks).toEqual([{ opId: expect.any(String), household: 1 }]);
    expect(await h.row(1)).toMatchObject({
      status: "queued",
      owner: "shared",
      template: "household",
      tier: "cheap",
      taskId: null,
      conversationId: null,
    });
    expect((await shared()).jobs["1"]).toMatchObject({
      requester: "owner",
      other: "second",
      consent: "asked",
      local: { owner: 4 },
    });
  });

  it("starts the job only on the other person's yes, and runs it to a stored result", async () => {
    const { h, apply } = await open();
    await apply("owner", propose());
    const joined = await apply("second", answer(1, true));
    expect(joined.acks[0]).toMatchObject({ household: 1 });
    expect(joined.started).toEqual([1]);
    await until(async () => (await h.row(1))?.status === "done");
    expect((await h.row(1))?.result?.text).toContain("plan for both");
  });

  it("ends a declined job failed with the decline text, and starts nothing", async () => {
    const { h, apply } = await open();
    await apply("owner", propose());
    const declined = await apply("second", answer(1, false));
    expect(declined.started).toEqual([]);
    expect(await h.row(1)).toMatchObject({
      status: "failed",
      taskId: null,
      result: { kind: "failure", text: "second declined to share the cost" },
    });
  });

  it("answers a repeated operation id with its stored answer and applies it once", async () => {
    const { apply, shared } = await open();
    const op = propose();
    const first = await apply("owner", op);
    const again = await apply("owner", op);
    expect(again.acks).toEqual(first.acks);
    expect(Object.keys((await shared()).jobs)).toEqual(["1"]);
  });

  it("forgets an applied operation's answer once it is older than the keep time", async () => {
    const { h, shared } = await open();
    const at = Date.now();
    const applyAt = (now: number, ...ops: Parameters<typeof applyOps>[2]) =>
      h.commit((tx) => applyOps(tx, "owner", ops, { task: h.task, now }));
    const old = propose();
    await applyAt(at, old);
    expect((await shared()).ops[old.opId]).toMatchObject({ opId: old.opId, at });
    const fresh = propose("owner", "second", { title: "book the ferry" });
    await applyAt(at + SHARED_OPS_KEEP_MS + 1, fresh);
    expect(Object.keys((await shared()).ops)).toEqual([fresh.opId]);
  });

  it("refuses an answer from the requester, a stranger, an op sent by another cell, and a second answer", async () => {
    const { h, apply } = await open();
    await apply("owner", propose());
    expect((await apply("owner", answer(1, true, "owner"))).acks[0]?.error).toBe(
      "only second answers shared job 1",
    );
    expect((await apply("third", answer(1, true, "third"))).acks[0]?.error).toBe(
      "no shared job 1 for third",
    );
    expect((await apply("owner", answer(1, true))).acks[0]?.error).toBe(
      "an operation of second came from owner",
    );
    expect((await h.row(1))?.taskId).toBeNull();
    await apply("second", answer(1, false));
    expect((await apply("second", answer(1, true))).acks[0]?.error).toBe(
      "shared job 1 was answered already",
    );
    expect((await apply("owner", propose("owner", "owner"))).acks[0]?.error).toBe(
      "a shared job needs two people",
    );
  });

  it("restarts only for the requester, refuses a job that has not started, and names resume refusals", async () => {
    const { h, apply } = await open();
    await apply("owner", propose());
    const restart = (opId: string, person: string) =>
      apply(person, { kind: "restart", opId, person, household: 1, note: "try again" });
    expect((await restart("r0", "owner")).acks[0]?.error).toBe("shared job 1 has not started");
    await apply("second", answer(1, true));
    await until(async () => (await h.row(1))?.status === "done");
    expect((await restart("r1", "second")).acks[0]?.error).toBe(
      "only owner's lead restarts this shared job",
    );
    expect((await restart("r2", "owner")).acks[0]?.error).toBe(
      "job 1 is done; only a started, unfinished job restarts.",
    );
    const resume = await apply("second", {
      kind: "resume",
      opId: "u1",
      person: "second",
      household: 1,
    });
    expect(resume.acks[0]?.error).toBe("shared job 1 is done");
  });

  it("names the joined, unfinished jobs a person's stop halts, and leaves an offer alone", async () => {
    const hold = createHold();
    hold.hold("household");
    const { h, apply } = await open(hold.wrap(plans));
    await apply("owner", propose());
    await apply("owner", propose());
    await apply("second", answer(2, true));
    await until(() => hold.waiting("household") === 1);
    const stopped = await apply("second", { kind: "stop", opId: "s1", person: "second" });
    expect(stopped.stops).toEqual([{ person: "second", jobs: [2] }]);
    expect(stopped.acks).toEqual([{ opId: "s1" }]);
    expect((await apply("owner", { kind: "stop", opId: "s2", person: "owner" })).stops).toEqual([
      { person: "owner", jobs: [2] },
    ]);
    expect((await h.row(1))?.status).toBe("queued");
    // A repeated stop whose effect never ran (the household ended after the commit) stops again,
    // with the same answer; once the effect is recorded as done, a repeat stops nothing.
    const again = await apply("second", { kind: "stop", opId: "s1", person: "second" });
    expect(again.stops).toEqual([{ person: "second", jobs: [2] }]);
    expect(again.acks).toEqual([{ opId: "s1" }]);
    expect(again.pending).toEqual(["s1"]);
    await h.commit((tx) => effectsDone(tx, ["s1"]));
    const done = await apply("second", { kind: "stop", opId: "s1", person: "second" });
    expect(done.stops).toEqual([]);
    expect(done.pending).toEqual([]);
    hold.release("household");
  });
});

describe("settlement and rows", () => {
  const nobodyOver = () => false;
  const setCost = (h: HouseholdStandIn, n: number, usd: number) =>
    h.commit(async (tx) => {
      const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
      if (row !== undefined) row.cost = usd;
    });

  async function joinedJob(respond?: Responder) {
    const opened = await open(respond);
    await opened.apply("owner", propose());
    await opened.apply("second", answer(1, true));
    return opened;
  }

  it("charges half each when both have budget", async () => {
    const { h } = await joinedJob();
    await setCost(h, 1, 0.4);
    const made = await h.commit((tx) => settle(tx, nobodyOver, 5_000));
    expect(made).toEqual([
      { id: "shared:1:1:owner", person: "owner", usd: 0.2, at: 5_000, split: "half" },
      { id: "shared:1:1:second", person: "second", usd: 0.2, at: 5_000, split: "half" },
    ]);
    expect(await h.commit((tx) => settle(tx, nobodyOver, 6_000))).toEqual([]);
  });

  it("charges the requester all when the other person's budget is used up", async () => {
    const { h } = await joinedJob();
    await setCost(h, 1, 0.4);
    const made = await h.commit((tx) => settle(tx, (p) => p === "second", 5_000));
    expect(made).toEqual([
      { id: "shared:1:1:owner", person: "owner", usd: 0.4, at: 5_000, split: "all" },
    ]);
  });

  it("splits each settlement by who is over then, when it changes mid-job", async () => {
    const { h } = await joinedJob();
    await setCost(h, 1, 0.2);
    await h.commit((tx) => settle(tx, nobodyOver, 5_000));
    await setCost(h, 1, 0.5);
    const second = await h.commit((tx) => settle(tx, (p) => p === "owner", 6_000));
    expect(second).toEqual([
      { id: "shared:1:2:second", person: "second", usd: 0.3, at: 6_000, split: "all" },
    ]);
    const rows = await h.commit((tx) => rowsFor(tx, "second", nobodyOver));
    expect(rows[0]?.charges.map((c) => c.usd)).toEqual([0.1, 0.3]);
  });

  it("charges nothing for a job still waiting for the other person", async () => {
    const { h, apply } = await open();
    await apply("owner", propose());
    await setCost(h, 1, 0.4);
    expect(await h.commit((tx) => settle(tx, nobodyOver, 5_000))).toEqual([]);
  });

  it("gives each person the rows they are part of, with their own number and payer", async () => {
    const { h, apply } = await open();
    await apply("owner", propose());
    const owner = await h.commit((tx) => rowsFor(tx, "owner", (p) => p === "second"));
    expect(owner).toEqual([
      expect.objectContaining({
        household: 1,
        requester: "owner",
        other: "second",
        consent: "asked",
        status: "queued",
        local: 4,
        payer: "you",
        estimateUsd: 0.25,
        result: null,
        charges: [],
      }),
    ]);
    const second = await h.commit((tx) => rowsFor(tx, "second", (p) => p === "second"));
    expect(second[0]).toMatchObject({ local: null, payer: "them" });
    expect(await h.commit((tx) => rowsFor(tx, "third", nobodyOver))).toEqual([]);
  });

  it("runs operations, settlement, and rows in one exchange", async () => {
    const { h } = await open();
    const deps = { task: h.task, budgets: async () => [], now: () => 7_000 };
    const first = await exchange(
      h.harness,
      { person: "owner", ops: [propose()] },
      deps,
      BACKGROUND_CONTEXT,
    );
    expect(first.answer.acks[0]?.household).toBe(1);
    expect(first.answer.rows.map((row) => row.household)).toEqual([1]);
    const offered = await exchange(
      h.harness,
      { person: "second", ops: [] },
      deps,
      BACKGROUND_CONTEXT,
    );
    expect(offered.answer.rows[0]).toMatchObject({
      consent: "asked",
      local: null,
      title: "plan the May trip",
    });
  });
});
