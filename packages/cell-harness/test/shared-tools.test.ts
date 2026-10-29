// The lead's shared-job tools: propose_shared_job commits a requesting row and its proposal and
// returns at once; offer_shared gives the person an offer; each refuses where it does not apply;
// neither waits for the household (AC-9).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopDoc } from "../src/docs.ts";
import { leadCalls } from "./escalation-helpers.ts";
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import { jobResponder } from "./responders.ts";
import { openPair, type SharedPair } from "./shared-pair.ts";

const PROPOSAL = {
  title: "plan the May trip",
  brief: "Plan the May trip for both of us.",
  estimate_usd: 0.8,
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
  it("proposes a waiting shared row with its estimate capped at the tier's cap, and delivers it in the background", async () => {
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
