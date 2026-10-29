// The person side of shared jobs, against a real household agent: the outbox goes out and is
// cleared by its acks, an offer becomes a row, status and result are mirrored once, a lost answer
// is sent again with the same operation id, a decline ends the requesting row, notices reach the
// lead once, and each charge is booked once on the person's month.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { JobBoardDoc } from "../src/docs.ts";
import { SHARED_OPS_MAX } from "../src/household-contract.ts";
import { readMonth } from "../src/month-ledger.ts";
import { sharedOpId, syncShared } from "../src/shared-relay.ts";
import {
  createHouseholdStub,
  loggedEvents,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { wakeNoticesOf } from "./job-helpers.ts";
import { answerFrom, open, openPair, proposeFrom } from "./shared-pair.ts";

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

  it("logs an operation the household refused, on both sides, and drops it from the outbox", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await openPair();
    const n = await proposeFrom(pair);
    await pair.sync("owner");
    // The requesting person cannot answer their own offer.
    await pair.owner.cell.harness.commit(async (tx) => {
      const link = (await tx.doc(JobBoardDoc)).jobs[String(n)]?.shared;
      if (link === null || link === undefined || link.household === null)
        throw new Error("no link");
      link.outbox.push({
        kind: "answer",
        opId: sharedOpId("owner", pair.clock.now),
        person: "owner",
        household: link.household,
        local: n,
        join: true,
      });
    }, BACKGROUND_CONTEXT);
    await pair.sync("owner");
    const refused = loggedEvents(warn.mock.calls).filter(
      (event) => event.event === "shared.op_refused",
    );
    expect(refused).toHaveLength(2);
    expect(refused).toContainEqual(
      expect.objectContaining({ cell: "owner", job: n, op: "answer", level: "warn" }),
    );
    expect(refused).toContainEqual(
      expect.objectContaining({ person: "owner", op: "answer", level: "warn" }),
    );
    expect((await pair.row("owner", n))?.shared?.outbox).toEqual([]);
    warn.mockRestore();
  });

  it("answers the board while an exchange with the household is still waiting", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release = () => {};
    let asked = 0;
    const household = {
      ...createHouseholdStub(),
      sharedSync: async () => {
        asked++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { acks: [], rows: [] };
      },
    };
    const t = await openTestCell({ person: "owner", household, persons: ["owner", "second"] });
    open.cells.push(t);
    const view = await t.cell.jobsView();
    expect(view.rows).toEqual([]);
    await until(async () => asked === 1);
    release();
  });

  it("sends at most the household's number of operations at once, and the rest next time", async () => {
    const pair = await openPair();
    const n = await proposeFrom(pair);
    await pair.sync("owner");
    await pair.owner.cell.harness.commit(async (tx) => {
      const link = (await tx.doc(JobBoardDoc)).jobs[String(n)]?.shared;
      if (link === null || link === undefined) throw new Error("no link");
      for (let i = 0; i < SHARED_OPS_MAX + 5; i++) {
        link.outbox.push({ kind: "stop", opId: `stop-${i}`, person: "owner" });
      }
    }, BACKGROUND_CONTEXT);
    await pair.sync("owner");
    expect(pair.requests.at(-1)?.ops).toHaveLength(SHARED_OPS_MAX);
    expect((await pair.row("owner", n))?.shared?.outbox).toHaveLength(5);
    await pair.sync("owner");
    expect(pair.requests.at(-1)?.ops).toHaveLength(5);
    expect((await pair.row("owner", n))?.shared?.outbox).toEqual([]);
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
          text: "[job 1 shared offer from owner: plan the May trip; the person's half is at most $0.13, or up to $0.25 if owner's limit is reached first. Call offer_shared with job 1, then ask the person in your own words whether to share the cost]",
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
    expect((await pair.row("owner", 1))?.shared?.unsent).toBeUndefined();
  });

  it("sends a notice an earlier exchange made but never delivered, once", async () => {
    const pair = await openPair();
    await proposeFrom(pair);
    await pair.sync("owner");
    // As after a restart between the reconcile commit and the delivery: the notice is kept.
    const lost = {
      job: 1,
      text: "[job 1 failure: pull it with job_result]",
      requestId: "wake:1:failure",
    };
    await pair.owner.cell.harness.commit(async (tx) => {
      const link = (await tx.doc(JobBoardDoc)).jobs["1"]?.shared;
      if (link) link.unsent = [lost];
    }, BACKGROUND_CONTEXT);
    expect(await pair.sync("owner")).toMatchObject({ notices: [lost] });
    expect((await pair.row("owner", 1))?.shared?.unsent).toBeUndefined();
    expect((await pair.sync("owner")) as { notices: unknown[] }).toMatchObject({ notices: [] });
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

describe("the sync routine and its triggers", () => {
  it("stores the routine's wake time, delivers an outbox op without the routine, and reads the board with the household down", async () => {
    const pair = await openPair();
    const wakes = await pair.owner.cell.wakes();
    expect(JSON.stringify(wakes)).toContain("shared-sync");
    const n = await proposeFrom(pair);
    pair.owner.cell.kickShared();
    await until(async () => (await pair.row("owner", n))?.shared?.outbox.length === 0);
    expect((await pair.row("owner", n))?.shared?.household).toBe(1);
    pair.setDown(true);
    const view = await pair.owner.cell.jobsView();
    expect(view.rows.map((row) => [row.number, row.status])).toEqual([[n, "waiting"]]);
  });

  it("has no routine and no exchange in a cell with no household", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const alone = await openTestCell();
    open.cells.push(alone);
    expect(JSON.stringify(await alone.cell.wakes())).not.toContain("shared-sync");
    expect(await alone.cell.syncShared()).toEqual({ outcome: "skipped" });
  });
});

describe("an offer to a person whose limit is reached", () => {
  it("reaches their lead at once when the requesting person pays all; a half offer still waits", async () => {
    const reports = [{ cell: "second", spentUsd: 0.02, limitUsd: 0.01 }];
    const pair = await openPair(undefined, undefined, async () => reports);
    // The person's limit is reached: every gated notice waits.
    const over = {
      isOver: async () => true,
      waitUntilUnder: () => new Promise<void>(() => {}),
    };
    const parts = { ...pair.parts("second"), gate: () => over };
    await proposeFrom(pair);
    await pair.sync("owner");
    const offered = await syncShared(parts, BACKGROUND_CONTEXT);
    expect(offered).toMatchObject({
      outcome: "ok",
      notices: [{ requestId: "shared:1:offer" }],
    });
    expect((offered as { notices: { text: string }[] }).notices[0]?.text).toContain(
      "so owner pays all",
    );
    await until(async () => (await wakeNoticesOf(pair.second.cell.root)).length === 1);

    // With nobody over, the household asks for half: that offer waits on the limit, and the
    // exchanges go on meanwhile (the board keeps mirroring the household).
    reports.length = 0;
    await proposeFrom(pair, "paint the hall");
    await pair.sync("owner");
    expect(await syncShared(parts, BACKGROUND_CONTEXT)).toMatchObject({
      outcome: "ok",
      notices: [{ requestId: "shared:2:offer" }],
    });
    expect(await syncShared(parts, BACKGROUND_CONTEXT)).toMatchObject({ outcome: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await wakeNoticesOf(pair.second.cell.root)).toHaveLength(1);
  });

  it("delivers a waiting notice once the limit allows it, without holding the exchanges", async () => {
    const pair = await openPair();
    let open = () => {};
    const under = new Promise<void>((resolve) => {
      open = resolve;
    });
    let over = true;
    const gate = {
      isOver: async () => over,
      waitUntilUnder: () => under,
    };
    const parts = { ...pair.parts("second"), gate: () => gate };
    await proposeFrom(pair);
    await pair.sync("owner");
    expect(await syncShared(parts, BACKGROUND_CONTEXT)).toMatchObject({ outcome: "ok" });
    expect(await syncShared(parts, BACKGROUND_CONTEXT)).toMatchObject({ outcome: "ok" });
    expect(await wakeNoticesOf(pair.second.cell.root)).toHaveLength(0);
    over = false;
    open();
    await until(async () => (await wakeNoticesOf(pair.second.cell.root)).length === 1);
  });

  it("logs the notice a failed delivery chain was on, and the ones it did not reach", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await openPair();
    const gate = {
      isOver: async () => true,
      waitUntilUnder: () => Promise.reject(new Error("closing")),
    };
    const parts = { ...pair.parts("second"), gate: () => gate };
    await proposeFrom(pair);
    await pair.sync("owner");
    expect(await syncShared(parts, BACKGROUND_CONTEXT)).toMatchObject({ outcome: "ok" });
    await until(() =>
      loggedEvents(warn.mock.calls).some((line) => line.event === "shared.notice_failed"),
    );
    const failed = loggedEvents(warn.mock.calls).find(
      (line) => line.event === "shared.notice_failed",
    );
    expect(failed).toMatchObject({ cell: "second", error: "closing" });
    expect(failed?.undelivered).toEqual([failed?.failed_job]);
    warn.mockRestore();
  });
});
