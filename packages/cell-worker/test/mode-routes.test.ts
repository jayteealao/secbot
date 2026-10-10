// The guard-mode routes through the worker on the stand-in: a new cell reads shadow, the operator
// key switches the mode and the decision model and reads them back, and neither a missing key nor
// a device key can switch (no device-key route reaches the mode).
import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, HOST, KEY, OPERATOR_KEY } from "./guard-setup.ts";

const setups: GuardSetup[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) await closeAll(setup);
  vi.restoreAllMocks();
});

async function setup() {
  const s = await guardSetup();
  setups.push(s);
  return s;
}

const call = (
  s: GuardSetup,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) =>
  route(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    s.env,
  );

const operator = { "x-secbot-operator": OPERATOR_KEY };
const device = { authorization: `Bearer ${KEY}` };

describe("the guard-mode routes (operator key)", () => {
  it("reads a new cell's shadow mode, switches it to enforce and back, and switches the decision model", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const shown = await call(s, "GET", "/ops/mode?cell=owner", operator);
    expect(shown.status).toBe(200);
    const first = (await shown.json()) as Record<string, unknown>;
    expect(first).toMatchObject({
      person: "owner",
      mode: "shadow",
      switchedBy: null,
      decisionModel: "jev",
      timeZone: "UTC",
    });
    expect(typeof first.since).toBe("number");

    const set = await call(s, "PUT", "/ops/mode?cell=owner", operator, { mode: "enforce" });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ mode: "enforce", switchedBy: "owner", changed: true });
    const again = await call(s, "PUT", "/ops/mode?cell=owner", operator, { mode: "enforce" });
    expect(await again.json()).toMatchObject({ mode: "enforce", changed: false });
    expect(await (await call(s, "GET", "/ops/mode?cell=owner", operator)).json()).toMatchObject({
      mode: "enforce",
    });

    const adapter = await call(s, "PUT", "/ops/decision-model?cell=owner", operator, {
      adapter: "clef",
    });
    expect(adapter.status).toBe(200);
    expect(await adapter.json()).toMatchObject({ decisionModel: "clef", mode: "enforce" });
    expect((await s.harness("owner").guardMode()).decisionModel).toBe("clef");
    // The decision model is read through GET /ops/mode; a GET of its own route is not found.
    expect((await call(s, "GET", "/ops/decision-model?cell=owner", operator)).status).toBe(404);
    expect((await call(s, "GET", "/ops/mode", operator)).status).toBe(400);

    const events = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string });
    expect(events.filter((event) => event.event === "guard.mode")).toHaveLength(1);
  });

  it("answers 400 to an unknown mode or adapter and changes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await setup();
    const mode = await call(s, "PUT", "/ops/mode?cell=owner", operator, { mode: "off" });
    expect(mode.status).toBe(400);
    expect(await mode.json()).toEqual({ error: 'refused: send {"mode": "shadow" | "enforce"}' });
    const adapter = await call(s, "PUT", "/ops/decision-model?cell=owner", operator, {
      adapter: "gpt",
    });
    expect(adapter.status).toBe(400);
    expect((await s.harness("owner").guardMode()).mode).toBe("shadow");
    expect((await s.harness("owner").guardMode()).decisionModel).toBe("jev");
  });

  it("refuses a switch with no key or with only a device key, and the mode stays shadow", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    // The first device request opens the person cell.
    expect((await call(s, "GET", "/v1/cells/owner/status", device)).status).toBe(200);
    const none = await call(s, "PUT", "/ops/mode?cell=owner", {}, { mode: "enforce" });
    expect(none.status).toBe(401);
    const byDevice = await call(s, "PUT", "/ops/mode?cell=owner", device, { mode: "enforce" });
    expect(byDevice.status).toBe(401);
    // No person route switches the mode.
    const personRoute = await call(s, "PUT", "/v1/cells/owner/mode", device, { mode: "enforce" });
    expect(personRoute.status).toBe(404);
    const refused = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event: string; route?: string })
      .filter((event) => event.event === "ops.refused");
    expect(refused.map((event) => event.route)).toEqual(["/ops/mode", "/ops/mode"]);
    expect((await s.harness("owner").guardMode()).mode).toBe("shadow");
  });
});
