// The secrets client over HTTP, against the worker's /internal/secrets route in process (the path
// a person cell in another fleet uses): a success answers the method's value, a refusal answers
// {error} with 400 and is not retried, a cell with no usable key answers 503, a brokered call and
// a rotation are sent once, and every call is logged with its status and time, never a value.
import { SecretsRefused, SecretsUnavailable } from "@secbot/cell-harness";
import { FakeCelldStorage, loggedEvents } from "@secbot/cell-harness/testing";
import { SecretsCell } from "@secbot/secrets-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCustody } from "../../secrets-cell/src/key-custody.ts";
import { route, type WorkerEnv } from "../src/index.ts";
import { OPERATOR_HEADER } from "../src/internal-rpc.ts";
import { httpSecretsClient } from "../src/secrets-client.ts";

const KEY = "k".repeat(32);
const URL_BASE = "http://secrets.internal:8789";
const VALUE = "plum orchard lantern"; // gitleaks:allow (fake test value)

const cells: SecretsCell[] = [];
afterEach(async () => {
  for (const cell of cells.splice(0)) await cell.close();
  vi.restoreAllMocks();
});

function secretsFleet(cell: SecretsCell) {
  const env = {
    SECBOT_OPERATOR_KEY: KEY,
    SECBOT_FLEET_CELLS: "secrets",
    SECRETS_CELL: { idFromName: (name: string) => name, get: () => cell },
    PERSON_CELL: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    },
  } as unknown as WorkerEnv;
  const seen: { path: string; key: string; status: number; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await route(request, env);
    seen.push({
      path: new URL(request.url).pathname,
      key: request.headers.get(OPERATOR_HEADER) ?? "",
      status: response.status,
      body: await response.clone().json(),
    });
    return response;
  };
  return { fetcher, seen };
}

describe("the secrets client over HTTP", () => {
  it("answers the bare value on success and {error} on a refusal, which is not retried", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      { custody: testCustody() },
    );
    cells.push(cell);
    const fleet = secretsFleet(cell);
    const client = httpSecretsClient(URL_BASE, KEY, fleet.fetcher);

    await client.add({ person: "owner", name: "test-secret", value: VALUE });
    await client.allowlist("owner", "test-secret", "research", "add");
    expect(await client.grant("owner", "test-secret", "research")).toEqual({ granted: true });
    expect(await client.get("owner", "research", "test-secret", "task-1:call-1")).toEqual({
      value: VALUE,
    });
    const listed = fleet.seen.find((each) => each.path === "/internal/secrets/grant");
    expect(listed).toMatchObject({ status: 200, body: { granted: true }, key: KEY });

    await expect(client.get("owner", "lead", "test-secret")).rejects.toThrow(SecretsRefused);
    const refused = fleet.seen.at(-1);
    expect(refused?.status).toBe(400);
    expect(refused?.body).toEqual({ error: expect.stringContaining("not granted") });
    expect(fleet.seen.filter((each) => each.path === "/internal/secrets/get")).toHaveLength(2);

    const events = loggedEvents([...log.mock.calls, ...warn.mock.calls]).filter(
      (event) => event.event === "secrets.call",
    );
    expect(events.at(-1)).toMatchObject({
      transport: "http",
      method: "get",
      person: "owner",
      outcome: "refused",
      http_status: 400,
      attempts: 1,
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(events)).not.toContain(VALUE);
  });

  it("sends a rotation once, and answers 503 with no usable key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      {
        custody: {
          ...testCustody(),
          health: async () => ({ ok: false as const, reason: "key file missing" }),
        },
      },
    );
    cells.push(down);
    const fleet = secretsFleet(down);
    const client = httpSecretsClient(URL_BASE, KEY, fleet.fetcher);
    await expect(client.rotate()).rejects.toThrow(SecretsUnavailable);
    expect(fleet.seen.map((each) => [each.path, each.status])).toEqual([
      ["/internal/secrets/rotate", 503],
    ]);
    await expect(client.list("owner")).rejects.toThrow(SecretsUnavailable);
    // A list is safe to repeat: three attempts, then one failed line with the last status.
    expect(fleet.seen.filter((each) => each.path === "/internal/secrets/list")).toHaveLength(3);
    const failed = loggedEvents(error.mock.calls).filter((event) => event.event === "secrets.call");
    expect(failed.at(-1)).toMatchObject({
      method: "list",
      outcome: "failed",
      http_status: 503,
      attempts: 3,
    });
  });

  it("sends a revoke once: a network failure is not retried", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      paths.push(new URL(new Request(input, init).url).pathname);
      throw new TypeError("network connection lost");
    };
    const client = httpSecretsClient(URL_BASE, KEY, fetcher);
    await expect(client.revoke("owner", "test-secret", "research")).rejects.toThrow(
      SecretsUnavailable,
    );
    expect(paths).toEqual(["/internal/secrets/revoke"]);
  });
});
