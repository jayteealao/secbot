// The lead's shared-job tools: propose_shared_job commits a requesting row and its proposal and
// returns at once; offer_shared gives the person an offer; each refuses where it does not apply;
// neither waits for the household (AC-9).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBoardDoc, type JobRow, StopDoc } from "../src/docs.ts";
import { SHARED_KEEPS_TIER, SHARED_NO_MARK, SHARED_NO_QUESTIONS } from "../src/lead-tools.ts";
import { leadCalls } from "./escalation-helpers.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { createHold, jobResponder } from "./responders.ts";
import { answerFrom, openPair, type SharedPair } from "./shared-pair.ts";

const PROPOSAL = {
  title: "plan the May trip",
  brief: "Plan the May trip for both of us.",
};

let alone: TestCell | undefined;
afterEach(async () => {
  await alone?.cell.close();
  alone = undefined;
});

async function offered(pair: SharedPair) {
  expect(await leadCalls(pair.owner, "propose_shared_job", PROPOSAL)).toBe(
    "job 1 waits for second to agree to share the cost; tell the person you asked them.",
  );
  await until(async () => (await pair.row("owner", 1))?.shared?.household === 1);
  await pair.sync("second");
}

describe("propose_shared_job and offer_shared", () => {
  it("proposes a waiting shared row whose estimate is the tier's cap, and delivers it in the background", async () => {
    const pair = await openPair();
    await offered(pair);
    const row = await pair.row("owner", 1);
    expect(row).toMatchObject({
      status: "waiting",
      template: "household",
      tier: "cheap",
      cap: 0.25,
    });
    expect(row?.shared).toMatchObject({ role: "requester", with: "second", estimateUsd: 0.25 });
    expect((await pair.row("second", 1))?.shared?.consent).toBe("offered");
  });

  it("gives the person an offer, once offered, and refuses anything else", async () => {
    const pair = await openPair();
    await offered(pair);
    expect(await leadCalls(pair.second, "offer_shared", { job: 1 })).toBe(
      'Ask the person in your own words now; the chat adds "[ job 1 shared ]" and their /join or /decline goes to the household.',
    );
    expect((await pair.row("second", 1))?.shared?.consent).toBe("shown");
    expect(await leadCalls(pair.owner, "offer_shared", { job: 1 })).toBe(
      "job 1 is not a shared offer waiting for the person.",
    );
    expect(await leadCalls(pair.second, "offer_shared", { job: 9 })).toContain("No job 9");
  });

  it("refuses a proposal with no household, during a stop, and with a bad deadline", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    alone = await openTestCell({ gateway: createFauxGateway(jobResponder) });
    expect(await leadCalls(alone, "propose_shared_job", PROPOSAL)).toBe(
      "This cell has no household to share a job with.",
    );
    const pair = await openPair();
    expect(
      await leadCalls(pair.owner, "propose_shared_job", { ...PROPOSAL, deadline: "soon" }),
    ).toContain("is not a date");
    await pair.owner.cell.harness.commit(async (tx) => {
      (await tx.doc(StopDoc)).active = { at: 1, by: "person" };
    }, BACKGROUND_CONTEXT);
    expect(await leadCalls(pair.owner, "propose_shared_job", PROPOSAL)).toBe(
      "Everything is being stopped; start it again once the stop is done.",
    );
  });

  it("returns in its round while the household has not answered", async () => {
    const pair = await openPair();
    pair.setDown(true);
    expect(await leadCalls(pair.owner, "propose_shared_job", PROPOSAL)).toContain("job 1 waits");
    expect((await pair.row("owner", 1))?.shared?.outbox).toHaveLength(1);
    pair.setDown(false);
    await pair.sync("owner");
    expect((await pair.row("owner", 1))?.shared?.outbox).toEqual([]);
  });
});

describe("lead tools on a shared row", () => {
  async function joined(pair: SharedPair) {
    await offered(pair);
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    await pair.sync("owner");
  }

  async function setRow(pair: SharedPair, who: "owner" | "second", change: (row: JobRow) => void) {
    await pair[who].cell.harness.commit(async (tx) => {
      const row = (await tx.doc(JobBoardDoc)).jobs["1"];
      if (row === undefined) throw new Error("no row");
      change(row);
    }, BACKGROUND_CONTEXT);
  }

  it("refuses set_job, mark_risky, answer_job, and ask_person on either side", async () => {
    const pair = await openPair();
    await joined(pair);
    for (const who of ["owner", "second"] as const) {
      const t = pair[who];
      expect(await leadCalls(t, "set_job", { job: 1, tier: "frontier" })).toBe(SHARED_KEEPS_TIER);
      expect(await leadCalls(t, "mark_risky", { job: 1, reason: "money" })).toBe(SHARED_NO_MARK);
      expect(await leadCalls(t, "mark_risky", { job: 1, reason: "x", risky: false })).toBe(
        SHARED_NO_MARK,
      );
      expect(await leadCalls(t, "answer_job", { job: 1, answer: "yes" })).toBe(SHARED_NO_QUESTIONS);
      expect(await leadCalls(t, "ask_person", { job: 1 })).toBe(SHARED_NO_QUESTIONS);
      expect((await pair.row(who, 1))?.taskId).toBeNull();
    }
  });

  it("sends the requester's one restart to the household and refuses the other person's and a second", async () => {
    const pair = await openPair();
    await joined(pair);
    expect(await leadCalls(pair.second, "restart_job", { job: 1, note: "try again" })).toBe(
      "only owner's lead restarts this shared job.",
    );
    expect(await leadCalls(pair.owner, "restart_job", { job: 1, note: "try the coast" })).toBe(
      "job 1 restarts in the household with a fresh subagent and your note; this was its one restart.",
    );
    await until(async () =>
      pair.requests.some((request) => request.ops.some((op) => op.kind === "restart")),
    );
    const restart = pair.requests
      .flatMap((request) => request.ops)
      .find((op) => op.kind === "restart");
    expect(restart).toMatchObject({ person: "owner", household: 1, note: "try the coast" });
    await setRow(pair, "owner", (row) => {
      row.attempts.restarts = 1;
    });
    expect(await leadCalls(pair.owner, "restart_job", { job: 1, note: "again" })).toBe(
      "Refused: shared job 1 has used its restart. Ask the person in your own words whether to start a new shared job at a higher tier.",
    );
    expect((await pair.row("owner", 1))?.taskId).toBeNull();
  });

  it("sends a resume of a stopped shared job from either side, and refuses one that is not stopped", async () => {
    const pair = await openPair();
    await joined(pair);
    await setRow(pair, "second", (row) => {
      row.status = "running";
    });
    expect(await leadCalls(pair.second, "resume_job", { job: 1 })).toContain(
      "only a stopped or blocked job resumes",
    );
    for (const who of ["owner", "second"] as const) {
      await setRow(pair, who, (row) => {
        row.status = "stopped";
      });
      pair.setDown(true);
      expect(await leadCalls(pair[who], "resume_job", { job: 1 })).toBe(
        "job 1 resumes in the household from its kept brief and transcript; this does not use its restart.",
      );
      const ops = (await pair.row(who, 1))?.shared?.outbox ?? [];
      expect(ops.at(-1)).toMatchObject({ kind: "resume", person: who, household: 1 });
      expect((await pair.row(who, 1))?.taskId).toBeNull();
      pair.setDown(false);
    }
  });

  it("refuses a restart or resume while the offer is not yet answered, and reads the shared line", async () => {
    const pair = await openPair();
    pair.setDown(true);
    await leadCalls(pair.owner, "propose_shared_job", PROPOSAL);
    expect(await leadCalls(pair.owner, "restart_job", { job: 1, note: "n" })).toBe(
      "job 1 waits for second to agree to share the cost; nothing runs yet.",
    );
    expect(await leadCalls(pair.owner, "resume_job", { job: 1 })).toBe(
      "job 1 waits for second to agree to share the cost; nothing runs yet.",
    );
    expect(await leadCalls(pair.owner, "read_job", { job: 1 })).toContain(
      "Shared with second (you pay half), proposed by you, consent asking.",
    );
  });
});

describe("the person's restart of a shared job", () => {
  async function joinedAndRunning() {
    const hold = createHold();
    hold.hold("household");
    const pair = await openPair(
      hold.wrap(() => fauxAssistantMessage([fauxText("Plan for both: the coast.")])),
    );
    await offered(pair);
    await answerFrom(pair, 1, true);
    await pair.sync("second");
    await until(() => hold.waiting("household") >= 1);
    await pair.sync("owner");
    return { pair, hold };
  }

  it("sends a resume to the household with no local job task, and both sides run it again", async () => {
    const { pair, hold } = await joinedAndRunning();
    try {
      // The household's stop waits for the held model step, so the hold opens once it is stopping
      // and closes again for the resumed run.
      const stopping = pair.second.cell.stop("person").then(() => pair.sync("second"));
      await until(
        async () =>
          (await pair.agent.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
      );
      hold.release("household");
      await stopping;
      hold.hold("household");
      await pair.sync("owner");
      expect((await pair.row("owner", 1))?.status).toBe("stopped");
      expect((await pair.row("second", 1))?.status).toBe("stopped");
      pair.setDown(true);
      expect(await pair.owner.cell.resumeJob(1)).toEqual({
        ok: true,
        job: 1,
        title: "plan the May trip",
      });
      const ops = (await pair.row("owner", 1))?.shared?.outbox ?? [];
      expect(ops.filter((op) => op.kind === "resume")).toHaveLength(1);
      expect(ops.at(-1)).toMatchObject({ kind: "resume", person: "owner", household: 1 });
      expect((await pair.row("owner", 1))?.taskId).toBeNull();
      pair.setDown(false);
      await pair.sync("owner");
      // The resumed run reaches its first model step and waits there.
      await until(() => hold.waiting("household") >= 1);
      expect((await pair.agent.view()).rows.find((row) => row.number === 1)?.status).toBe(
        "running",
      );
      await pair.sync("owner");
      await pair.sync("second");
      expect((await pair.row("owner", 1))?.status).toBe("running");
      expect((await pair.row("second", 1))?.status).toBe("running");
      expect((await pair.row("owner", 1))?.taskId).toBeNull();
    } finally {
      hold.release("household");
    }
  });

  it("leaves a shared job to the household in the owner's stop of everything, and counts it there", async () => {
    const { pair, hold } = await joinedAndRunning();
    try {
      // The owner's stop reaches the household itself, which stops and counts the shared job.
      expect(await pair.owner.cell.stop("owner")).toMatchObject({ jobs: 0 });
      expect(await pair.second.cell.stop("owner")).toMatchObject({ jobs: 0 });
      for (const who of ["owner", "second"] as const) {
        expect((await pair.row(who, 1))?.shared?.outbox ?? []).toEqual([]);
      }
      const stopping = pair.agent.stop("owner");
      await until(
        async () =>
          (await pair.agent.harness.snapshot(StopDoc, BACKGROUND_CONTEXT))?.active != null,
      );
      hold.release("household");
      expect(await stopping).toMatchObject({ jobs: 1 });
      // A person's own stop still sends the household a stop of their shared jobs.
      await pair.sync("owner");
      expect((await pair.row("owner", 1))?.status).toBe("stopped");
    } finally {
      hold.release("household");
    }
  });

  it("refuses a shared job that is not stopped, and an offer not yet answered", async () => {
    const { pair, hold } = await joinedAndRunning();
    try {
      expect(await pair.owner.cell.resumeJob(1)).toEqual({ ok: false, reason: "not-stopped" });
      pair.setDown(true);
      await leadCalls(pair.owner, "propose_shared_job", { ...PROPOSAL, title: "paint the hall" });
      expect(await pair.owner.cell.resumeJob(2)).toEqual({ ok: false, reason: "not-stopped" });
      expect((await pair.row("owner", 2))?.taskId).toBeNull();
      expect((await pair.row("owner", 1))?.shared?.outbox ?? []).toEqual([]);
    } finally {
      hold.release("household");
    }
  });
});
