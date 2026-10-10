// The held-call routes through the worker on the stand-in (the routes the command line uses now
// and the app later): list, allow, always, deny, and every refusal.
import { until } from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY } from "./guard-setup.ts";

const setups: GuardSetup[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) await closeAll(setup);
  vi.restoreAllMocks();
});

async function setup(options: Parameters<typeof guardSetup>[1] = {}) {
  const s = await guardSetup(undefined, options);
  setups.push(s);
  return s;
}

const device = (s: GuardSetup, method: string, path: string, body?: unknown) =>
  route(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    s.env,
  );

const handoff = (specialist: string) =>
  `CALL handoff ${JSON.stringify({ specialist, brief: `Ask ${specialist}.` })}`;

/** A person ask-first rule on the lead's hand-off, then one held hand-off to `specialist`. */
async function holdOne(s: GuardSetup, specialist: string, id: string) {
  // The first request opens the person cell.
  expect((await device(s, "GET", "/v1/cells/owner/status")).status).toBe(200);
  await s.cells.get("owner")?.submitInput("owner", handoff(specialist), id);
  const harness = s.harness("owner");
  await until(async () =>
    (await harness.heldCalls()).some((call) => call.summary === `handoff -> ${specialist}`),
  );
}

describe("the held-call routes (device key)", () => {
  it("lists held calls and answers allow, always, and deny", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const rule = { agent: "lead", tool: "handoff", verdict: "ask-first" };
    expect((await device(s, "POST", "/v1/cells/owner/rules", rule)).status).toBe(201);
    await holdOne(s, "research", "route-1");

    const listed = (await (await device(s, "GET", "/v1/cells/owner/approvals")).json()) as {
      held: { number: number; summary: string; reasonSource: string; remainingMs: number }[];
    };
    expect(listed.held).toEqual([
      expect.objectContaining({
        number: 1,
        summary: "handoff -> research",
        reasonSource: "your-rule",
      }),
    ]);
    expect(listed.held[0]?.remainingMs).toBeGreaterThan(23 * 3_600_000);
    const missed = (await (await device(s, "GET", "/v1/cells/owner/missed")).json()) as {
      held: { number: number }[];
    };
    expect(missed.held.map((call) => call.number)).toEqual([1]);

    const allowed = await device(s, "POST", "/v1/cells/owner/approvals/1", { answer: "allow" });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      number: 1,
      status: "allowed",
      answer: "allow",
      agent: "lead",
      tool: "handoff",
      summary: "handoff -> research",
      answeredBy: "owner",
      rule: null,
    });
    const again = await device(s, "POST", "/v1/cells/owner/approvals/1", { answer: "deny" });
    expect([again.status, await again.json()]).toEqual([409, { error: "answered" }]);

    await holdOne(s, "health", "route-2");
    const always = await device(s, "POST", "/v1/cells/owner/approvals/2", { answer: "always" });
    expect(always.status).toBe(200);
    expect(await always.json()).toMatchObject({
      status: "always",
      rule: {
        agent: "lead",
        tool: "handoff",
        verdict: "permit",
        source: "allow-always",
        match: { kind: "exact", field: "specialist", value: "health" },
      },
    });

    await holdOne(s, "household", "route-3");
    const denied = await device(s, "POST", "/v1/cells/owner/approvals/3", { answer: "deny" });
    expect(await denied.json()).toMatchObject({ number: 3, status: "denied", answeredBy: "owner" });
    expect((await (await device(s, "GET", "/v1/cells/owner/approvals")).json()) as unknown).toEqual(
      {
        held: [],
      },
    );
  });

  it("refuses an unknown number, a bad body, allow always under an owner rule, and another person", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const unknown = await device(s, "POST", "/v1/cells/owner/approvals/3", { answer: "allow" });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "no held call #3" }]);
    const bad = await device(s, "POST", "/v1/cells/owner/approvals/1", { answer: "yes" });
    expect(bad.status).toBe(400);

    await s.harness("owner").addRule("owner", {
      agent: "all",
      tool: "handoff",
      verdict: "ask-first",
      match: { kind: "exact", field: "specialist", value: "developer" },
    });
    await holdOne(s, "developer", "route-4");
    const always = await device(s, "POST", "/v1/cells/owner/approvals/1", { answer: "always" });
    expect([always.status, await always.json()]).toEqual([
      400,
      { error: "refused: allow always is not offered: an owner rule asks first here" },
    ]);
    // Still held; allow once is still possible.
    const allowed = await device(s, "POST", "/v1/cells/owner/approvals/1", { answer: "allow" });
    expect(allowed.status).toBe(200);

    const other = await device(s, "GET", "/v1/cells/second/approvals");
    expect(other.status).toBe(403);
    const otherAnswer = await device(s, "POST", "/v1/cells/second/approvals/1", {
      answer: "allow",
    });
    expect(otherAnswer.status).toBe(403);
  });

  it("refuses a late answer with 409 lapsed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup({ guard: { holdMs: 50 } });
    const rule = { agent: "lead", tool: "handoff", verdict: "ask-first" };
    expect((await device(s, "POST", "/v1/cells/owner/rules", rule)).status).toBe(201);
    await holdOne(s, "research", "route-5");
    const harness = s.harness("owner");
    await until(async () => (await harness.activity()).records.some((r) => r.kind === "lapsed"));
    const late = await device(s, "POST", "/v1/cells/owner/approvals/1", { answer: "allow" });
    expect([late.status, await late.json()]).toEqual([409, { error: "lapsed" }]);
  });
});
