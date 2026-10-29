// The household's shared store: each operation from a person cell applies once by its operation
// id; only the other person's yes starts the job; a decline ends it; restart, resume, and stop
// follow who may do them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOps, SharedJobsDoc } from "../src/shared-jobs.ts";
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
    hold.release("household");
  });
});
