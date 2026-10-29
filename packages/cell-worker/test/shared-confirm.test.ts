// A shared job's confirm, end to end on two fleets: the worker's routes, the real `owner` and
// `second` person cells, and the real household cell with the faux model, driven through two
// scripted `secbot chat` sessions. The other person sees the confirm line once (also after a
// reconnect); nothing runs in the household until their /join; the joined line and the
// requesting chat's notice print; a /decline prints the declined line and the requesting lead
// pulls the decline as a failure; with the other person's limit reached the line says the
// requesting person pays all. With SECBOT_EVIDENCE_DIR set, each transcript is written there.

import { until } from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatSession,
  chatSession,
  evidence,
  fitsTerminal,
  householdRow,
  OFFER_ASK,
  relayText,
  type SharedSetup,
  sharedSetup,
} from "./shared-setup.ts";

let s: SharedSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const SHARED_LINE = (n: number) =>
  `[ job ${n} shared ] /join ${n} to share the cost, /decline ${n} to leave it to owner`;

const count = (text: string, part: string) => text.split(part).length - 1;

/** A transcript as evidence: what the chat printed, its stderr, and exit code 0. */
const transcript = (chat: ChatSession, from = 0) => ({
  code: 0,
  out: chat.out().slice(from),
  err: chat.err(),
});

async function opened() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  s = await sharedSetup({ fleets: 2 });
  const setup = s;
  for (const person of ["owner", "second"]) {
    expect((await setup.secbotAs(person, ["jobs"])).code).toBe(0);
  }
  const owner = chatSession(setup, "owner");
  const second = chatSession(setup, "second");
  await owner.open();
  await second.open();
  /** The owner's lead proposes; both persons' exchanges run; the other lead gives the offer. */
  const propose = async (title: string, n: number) => {
    await owner.say(`SHARE ${title}`);
    await until(async () => (await setup.harness("owner").board()).jobs[String(n)] !== undefined);
    await until(
      async () => (await setup.harness("owner").board()).jobs[String(n)]?.shared?.household != null,
    );
    await setup.harness("second").syncShared();
    await until(() => second.out().includes(`[ job ${n} shared ]`));
  };
  return { setup, owner, second, propose };
}

describe("a shared job's confirm in secbot chat, end to end (AC-32)", () => {
  it("asks once, starts only on /join, and tells the requesting chat", {
    timeout: 60_000,
  }, async () => {
    const { setup, owner, second, propose } = await opened();
    await propose("plan the May trip", 1);
    const offer = second.out();
    const lines = offer.split("\n");
    const ask = lines.indexOf(OFFER_ASK);
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(lines.slice(ask, ask + 3)).toEqual([OFFER_ASK, "", SHARED_LINE(1)]);
    expect(count(offer, "[ job 1 shared ]")).toBe(1);
    await evidence("ac-32-offer", transcript(second));

    // A reconnect sends the open offer again; the chat prints its line once.
    const before = second.out().length;
    await second.reconnect();
    await until(() => count(second.out(), "connected to") === 2);
    expect(count(second.out(), "[ job 1 shared ]")).toBe(1);
    await evidence("ac-32-reconnect", transcript(second, before));

    // Nothing runs in the household before the other person's answer.
    const row = await householdRow(setup, 1);
    expect(row?.status).toBe("queued");
    expect(row?.taskId ?? null).toBeNull();
    expect(setup.gateway.requests.filter((request) => request.role === "household")).toEqual([]);

    const joinedFrom = second.out().length;
    await second.say("/join 1");
    expect(second.out()).toContain("> /join 1\n[ joined ] #1 plan the May trip; you pay half\n");
    await evidence("ac-32-join", transcript(second, joinedFrom));
    await until(async () => (await householdRow(setup, 1))?.taskId != null);
    await until(() => setup.gateway.requests.some((request) => request.role === "household"));

    await setup.harness("owner").syncShared();
    const notice = "On it, for both of you: plan the May trip (job 1, household, shared)";
    await until(() => owner.out().includes(notice));
    await evidence("ac-32-notice", transcript(owner));

    for (const chat of [owner, second]) {
      expect(fitsTerminal(chat.out())).toBe(true);
      expect(chat.err()).toBe("");
    }
  });

  it("prints the declined line and the requesting lead pulls the decline", {
    timeout: 60_000,
  }, async () => {
    const { setup, owner, second, propose } = await opened();
    await propose("paint the hall", 1);
    const declinedFrom = second.out().length;
    await second.say("/decline 1");
    expect(second.out().slice(declinedFrom)).toBe(
      "> /decline 1\n[ declined ] #1 paint the hall; owner's lead was told\n",
    );
    await evidence("ac-32-decline", transcript(second, declinedFrom));

    const noticeFrom = owner.out().length;
    await setup.harness("owner").syncShared();
    await until(() => owner.out().includes(relayText("second declined to share the cost")));
    const pulled = setup.gateway.requests.filter(
      (request) =>
        request.role === "lead" &&
        request.last?.role === "toolResult" &&
        request.lastText.includes("second declined to share the cost"),
    );
    expect(pulled.length).toBeGreaterThan(0);
    await evidence("ac-32-decline-notice", transcript(owner, noticeFrom));

    const row = await householdRow(setup, 1);
    expect(row?.taskId ?? null).toBeNull();
    expect(setup.gateway.requests.filter((request) => request.role === "household")).toEqual([]);
    expect(fitsTerminal(second.out())).toBe(true);
    expect(fitsTerminal(owner.out())).toBe(true);
  });

  it("says the requesting person pays all when the other's limit is reached", {
    timeout: 60_000,
  }, async () => {
    const { setup, second, propose } = await opened();
    await setup.budgetOver("second");
    const from = second.out().length;
    await propose("fix the fence", 1);
    const printed = second.out().slice(from);
    expect(printed).toContain(
      "[ job 1 shared ] your limit is reached, so owner pays all; /join 1 to see it on\n  your board, /decline 1 to leave it\n",
    );
    await evidence("ac-32-limit", transcript(second, from));
    expect(fitsTerminal(second.out())).toBe(true);
  });
});
