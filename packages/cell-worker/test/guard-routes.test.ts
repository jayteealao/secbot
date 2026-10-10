// The guard's routes through the worker on the stand-in: the person's rules and activity behind
// the device key, the owner's rules and activity behind the operator key, and the refusals.
import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, OPERATOR_KEY } from "./guard-setup.ts";

const setups: GuardSetup[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) await closeAll(setup);
  vi.restoreAllMocks();
});

async function setup(fleet?: string) {
  const s = await guardSetup(fleet);
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

const operator = (
  s: GuardSetup,
  method: string,
  path: string,
  body?: unknown,
  key = OPERATOR_KEY,
) =>
  route(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { "x-secbot-operator": key, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    s.env,
  );

const LOOSER = {
  agent: "lead",
  tool: "handoff",
  verdict: "permit",
  match: { kind: "exact", field: "specialist", value: "developer" },
};
const OWNER_ASK = {
  agent: "all",
  tool: "handoff",
  verdict: "ask-first",
  match: { kind: "exact", field: "specialist", value: "developer" },
};

describe("the person's guard routes (device key)", () => {
  it("lists, adds, refuses, and removes rules", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const listed = (await (await device(s, "GET", "/v1/cells/owner/rules")).json()) as {
      owner: { tool: string; source: string }[];
      person: { tool: string }[];
      timeZone: string;
    };
    expect(listed.owner.map((r) => [r.tool, r.source])).toEqual([
      ["pay", "release"],
      ["set_reminder", "release"],
      ["search_history", "release"],
    ]);
    expect(listed.person.map((r) => r.tool)).toEqual([
      "handoff",
      "household_change",
      "set_reminder",
      "search_history",
    ]);
    expect(listed.timeZone).toBe("UTC");

    const added = await device(s, "POST", "/v1/cells/owner/rules", {
      agent: "lead",
      tool: "handoff",
      verdict: "permit",
      match: { kind: "exact", field: "specialist", value: "research" },
    });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { rule: { source: string } }).rule.source).toBe("person");

    const unknown = await device(s, "POST", "/v1/cells/owner/rules", { agent: "x", tool: "y" });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/^refused: unknown agent/);

    const removed = await device(s, "DELETE", "/v1/cells/owner/rules", {
      agent: "lead",
      tool: "handoff",
      match: { kind: "exact", field: "specialist", value: "research" },
    });
    expect(removed.status).toBe(200);
    const missing = await device(s, "DELETE", "/v1/cells/owner/rules", {
      agent: "lead",
      tool: "handoff",
    });
    expect(missing.status).toBe(404);
    // The device key edits only the person's level: the release rule is not on it.
    const release = await device(s, "DELETE", "/v1/cells/owner/rules", {
      agent: "all",
      tool: "pay",
    });
    expect(release.status).toBe(404);
  });

  it("refuses a person rule looser than an owner rule with 400 naming the owner rule", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    expect((await operator(s, "POST", "/ops/rules?cell=owner", OWNER_ASK)).status).toBe(201);
    const refused = await device(s, "POST", "/v1/cells/owner/rules", LOOSER);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error:
        "refused: this rule is looser than an owner rule:\n  all handoff (specialist = developer) -> ask first\n  Your rules can be stricter than the owner's rules, never looser.",
    });
  });

  it("checks the activity query and answers an empty month", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    for (const query of ["month=2026-13", "limit=0", "limit=500", "before=x"]) {
      expect((await device(s, "GET", `/v1/cells/owner/activity?${query}`)).status, query).toBe(400);
    }
    const empty = await device(s, "GET", "/v1/cells/owner/activity?month=2026-09");
    expect(await empty.json()).toEqual({
      person: "owner",
      month: "2026-09",
      timeZone: "UTC",
      total: 0,
      records: [],
      next: null,
      spentUsd: 0,
      live: [],
    });
  });
});

describe("the owner's guard routes (operator key)", () => {
  it("refuses a request without the operator key, and a device key there", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    expect((await operator(s, "GET", "/ops/rules?cell=owner", undefined, "wrong")).status).toBe(
      401,
    );
    expect((await device(s, "GET", "/ops/rules?cell=owner")).status).toBe(401);
    expect((await device(s, "GET", "/ops/activity?cell=owner")).status).toBe(401);
    const refused = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string });
    expect(refused.filter((e) => e.event === "ops.refused")).toHaveLength(3);
  });

  it("adds and removes owner rules, never the release rule, and reads activity", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const added = await operator(s, "POST", "/ops/rules?cell=owner", OWNER_ASK);
    expect(added.status).toBe(201);
    expect(((await added.json()) as { rule: { source: string } }).rule.source).toBe("owner");
    const listed = (await (await operator(s, "GET", "/ops/rules?cell=owner")).json()) as {
      owner: unknown[];
    };
    expect(listed.owner).toHaveLength(4);
    const release = await operator(s, "DELETE", "/ops/rules?cell=owner", {
      agent: "all",
      tool: "pay",
    });
    expect(release.status).toBe(400);
    expect(await release.json()).toEqual({
      error: "refused: this rule is part of the release: any pay tool -> prohibit",
    });
    // A permit for every reminder of the lead is looser than the owner card-number rule.
    const looser = await device(s, "POST", "/v1/cells/owner/rules", {
      agent: "lead",
      tool: "set_reminder",
      verdict: "permit",
    });
    expect(looser.status).toBe(400);
    expect(((await looser.json()) as { error: string }).error).toMatch(
      /^refused: this rule is looser than an owner rule:\n {2}all set_reminder \(text ~ /,
    );

    const removed = await operator(s, "DELETE", "/ops/rules?cell=owner", OWNER_ASK);
    expect(removed.status).toBe(200);
    const activity = await operator(s, "GET", "/ops/activity?cell=person&month=2026-10");
    expect(await activity.json()).toMatchObject({ person: "second", month: "2026-10", total: 0 });
    expect((await operator(s, "GET", "/ops/activity?cell=owner&limit=999")).status).toBe(400);
  });

  it("answers only for this fleet's person cells", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup("second,household");
    const other = await operator(s, "GET", "/ops/rules?cell=owner");
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "cell owner is served by another fleet" });
    const household = await operator(s, "GET", "/ops/rules?cell=household");
    expect(household.status).toBe(404);
    expect(await household.json()).toEqual({ error: "household is not a person cell" });
  });
});
