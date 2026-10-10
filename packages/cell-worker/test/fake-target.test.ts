// The test-cell worker's fake health target and guard-bench routing on the stand-in: no header is
// refused with 401, a header is echoed back, and the secrets cell's broker against the route (the
// stand-in key custody, as secrets-routes.test.ts) returns the answer with the token taken out.
import { FakeCelldStorage } from "@secbot/cell-harness/testing";
import { SecretsCell, testCustody } from "@secbot/secrets-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import conformanceWorker, {
  type ConformanceEnv,
  type DurableObjectNamespaceLike,
} from "../src/conformance-entry.ts";
import { OPERATOR_HEADER } from "../src/internal-rpc.ts";

const TOKEN = "hb-test-token-5c1e9a7b3d2f4e60"; // gitleaks:allow (fake test token)
const CELL = "https://cells.example.test";

const noCell: DurableObjectNamespaceLike = {
  idFromName: (name) => name,
  get: () => ({ fetch: async () => Response.json({ error: "unused" }, { status: 500 }) }),
};
const OPERATOR_KEY = "o".repeat(32); // gitleaks:allow (fake test key)
const env: ConformanceEnv = { CONFORMANCE: noCell, SECBOT_OPERATOR_KEY: OPERATOR_KEY };
const operator = { [OPERATOR_HEADER]: OPERATOR_KEY };

const worker = (input: string, init?: RequestInit) =>
  conformanceWorker.fetch(new Request(input, init), env);

const secretsCells: SecretsCell[] = [];
afterEach(async () => {
  for (const cell of secretsCells.splice(0)) await cell.close();
  vi.restoreAllMocks();
});

describe("the fake health target", () => {
  it("refuses a call with no authorization header", async () => {
    const response = await worker(`${CELL}/fake-target/v1/ping`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "no authorization header" });
  });

  it("echoes the header and the path under the target", async () => {
    const response = await worker(`${CELL}/fake-target/v1/ping`, {
      headers: { authorization: TOKEN },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: "/v1/ping", echoed: TOKEN });
  });

  it("is reached by the secrets cell's broker, whose answer never holds the token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const secrets = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      {
        custody: testCustody(),
        fetch: (input, init) => worker(String(input), init),
      },
    );
    secretsCells.push(secrets);
    const added = await secrets.add({
      person: "owner",
      name: "health-test",
      value: TOKEN,
      broker: { kind: "health", url: `${CELL}/fake-target`, header: "authorization" },
    });
    expect(added.ok).toBe(true);
    expect(
      (
        await secrets.allowlist({
          person: "owner",
          secret: "health-test",
          agent: "health",
          action: "add",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await secrets.grant({ person: "owner", secret: "health-test", agent: "health" })).ok,
    ).toBe(true);
    const answer = await secrets.broker({
      person: "owner",
      agent: "health",
      name: "health-test",
      request: { method: "GET", path: "/v1/ping" },
    });
    expect(answer.ok).toBe(true);
    const text = JSON.stringify(answer);
    expect(text).toContain("/v1/ping");
    expect(text).toContain('\\"ok\\":true');
    expect(text).not.toContain(TOKEN);
  });
});

describe("the guard-bench routing", () => {
  it("refuses the bench routes without the operator key, since they start paid model calls", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await worker(`${CELL}/lab/guard-bench?calls=1`, { method: "POST" })).status).toBe(401);
    expect((await worker(`${CELL}/lab/guard-bench-state`)).status).toBe(401);
    const device = { [OPERATOR_HEADER]: "d".repeat(32) };
    expect(
      (await worker(`${CELL}/lab/guard-bench?calls=1`, { method: "POST", headers: device })).status,
    ).toBe(401);
  });

  it("answers 503 without the GUARD_BENCH binding, and sends the routes to it with one", async () => {
    expect(
      (await worker(`${CELL}/lab/guard-bench?calls=1`, { method: "POST", headers: operator }))
        .status,
    ).toBe(503);
    const seen: string[] = [];
    const bench = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: async (request: Request) => {
          seen.push(`${String(id)} ${request.method} ${new URL(request.url).pathname}`);
          return Response.json({ done: false });
        },
      }),
    };
    const withBench: ConformanceEnv = { ...env, GUARD_BENCH: bench };
    await conformanceWorker.fetch(
      new Request(`${CELL}/lab/guard-bench-state`, { headers: operator }),
      withBench,
    );
    await conformanceWorker.fetch(
      new Request(`${CELL}/lab/guard-bench?calls=3`, { method: "POST", headers: operator }),
      withBench,
    );
    expect(seen).toEqual(["bench GET /lab/guard-bench-state", "bench POST /lab/guard-bench"]);
  });
});
