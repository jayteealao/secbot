// The household client over HTTP, against the worker's /internal/household route in process (the
// path the owner cell uses across fleets, and the test cell uses against itself): the owner cell
// adds an item and the second cell reads it over HTTP; an answer lost after apply() ran is
// retried with the same operation id and applies once over HTTP; a refusal is not retried.
import { FakeCelldStorage, loggedEvents } from "@secbot/cell-harness/testing";
import { HouseholdCell } from "@secbot/household-cell";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  householdClientOf,
  httpHouseholdClient,
  OPERATOR_HEADER,
} from "../src/household-client.ts";
import { route, type WorkerEnv } from "../src/index.ts";

const KEY = "k".repeat(32);
const URL_BASE = "http://household.internal:8789";

const households: HouseholdCell[] = [];
afterEach(async () => {
  for (const household of households.splice(0)) await household.close();
  vi.restoreAllMocks();
});

function householdFleet() {
  const household = new HouseholdCell({ storage: new FakeCelldStorage() }, {}, { pollMs: 5 });
  households.push(household);
  const env = {
    SECBOT_OPERATOR_KEY: KEY,
    SECBOT_FLEET_CELLS: "second,household",
    HOUSEHOLD_CELL: { idFromName: (name: string) => name, get: () => household },
    PERSON_CELL: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    },
  } as WorkerEnv;
  const keys: string[] = [];
  let dropNextAnswer = false;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    keys.push(request.headers.get(OPERATOR_HEADER) ?? "");
    const response = await route(request, env);
    if (dropNextAnswer) {
      dropNextAnswer = false;
      throw new TypeError("fetch failed: connection reset after the method started");
    }
    return response;
  };
  return {
    household,
    fetcher,
    keys,
    dropNext: () => {
      dropNextAnswer = true;
    },
  };
}

describe("household client over HTTP", () => {
  it("lets the second cell read the owner cell's item, and applies a retried change once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fleet = householdFleet();
    const owner = householdClientOf(
      { SECBOT_HOUSEHOLD_URL: URL_BASE, SECBOT_OPERATOR_KEY: KEY },
      fleet.fetcher,
    );
    if (owner === undefined) throw new Error("no client");
    fleet.dropNext();
    const change = {
      opId: "owner:5:call-1",
      document: "list",
      fromCell: "owner",
      kind: "add" as const,
      text: "tomatoes",
    };
    const result = await owner.apply(change);
    expect(result).toMatchObject({ outcome: "applied", duplicate: true });
    const second = httpHouseholdClient(`${URL_BASE}/`, KEY, fleet.fetcher);
    const read = await second.read("list");
    expect(read.items.map((item) => [item.itemId, item.text])).toEqual([
      ["owner:5:call-1", "tomatoes"],
    ]);
    expect(await fleet.household.history("list")).toHaveLength(1);
    expect(fleet.keys.every((key) => key === KEY)).toBe(true);

    const calls = loggedEvents(log.mock.calls).filter((line) => line.event === "household.call");
    expect(calls).toEqual([
      {
        event: "household.call",
        level: "info",
        transport: "http",
        method: "apply",
        outcome: "retried",
        attempts: 2,
      },
      {
        event: "household.call",
        level: "info",
        transport: "http",
        method: "read",
        outcome: "ok",
        attempts: 1,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("tomatoes");
  });

  it("does not retry a refusal, and fails after three network errors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fleet = householdFleet();
    const wrongKey = httpHouseholdClient(URL_BASE, "wrong", fleet.fetcher);
    await expect(wrongKey.read("list")).rejects.toThrow("refused: operator_key");
    expect(fleet.keys).toHaveLength(1);

    let attempts = 0;
    const down = httpHouseholdClient(URL_BASE, KEY, async () => {
      attempts++;
      throw new TypeError("fetch failed");
    });
    await expect(down.read("list")).rejects.toThrow("fetch failed");
    expect(attempts).toBe(3);

    // Each failure names its cause: the status of a refusal, the error of a failed call.
    const refused = loggedEvents(warn.mock.calls).filter((line) => line.event === "household.call");
    expect(refused).toEqual([
      expect.objectContaining({
        level: "warn",
        method: "read",
        outcome: "refused",
        attempts: 1,
        status: 401,
        error: "refused: operator_key",
      }),
    ]);
    const failed = loggedEvents(error.mock.calls).filter((line) => line.event === "household.call");
    expect(failed).toEqual([
      expect.objectContaining({
        level: "error",
        method: "read",
        outcome: "failed",
        attempts: 3,
        status: null,
        error_name: "TypeError",
      }),
    ]);
    // The household side logs the refusal of the wrong key as well.
    expect(loggedEvents(warn.mock.calls).some((line) => line.event === "ops.refused")).toBe(true);
  });

  it("uses the binding when no URL is set, and has no client with neither", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fleet = householdFleet();
    const viaBinding = householdClientOf({
      HOUSEHOLD_CELL: { idFromName: (name) => name, get: () => fleet.household },
    });
    expect((await viaBinding?.read("list"))?.items).toEqual([]);
    expect(householdClientOf({})).toBeUndefined();
  });
});
