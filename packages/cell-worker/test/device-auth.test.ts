// A registered device key on a private host name passes; a missing, unknown, or revoked
// key, a key for another person, and a request not addressed to a private host name are refused
// and logged, and no log line holds the key, its hash, or the full host name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDevice, parseDeviceKeys, sha256Hex } from "../src/device-auth.ts";
import { route, type WorkerEnv } from "../src/index.ts";

const OWNER_KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef";
const SECOND_KEY = "second-phone-key-0123456789abcdef0123456789abcdef";
const HOST = "cells.example.test";

async function env(extra: Partial<WorkerEnv> = {}): Promise<WorkerEnv> {
  return {
    SECBOT_DEVICE_KEYS: `laptop:owner:${await sha256Hex(OWNER_KEY)}, phone:second:${await sha256Hex(SECOND_KEY)}`,
    SECBOT_PRIVATE_HOSTS: `${HOST}, other.example.test`,
    PERSON_CELL: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) =>
          Response.json({
            id,
            person: request.headers.get("x-secbot-person"),
            device: request.headers.get("x-secbot-device"),
            auth: request.headers.get("authorization"),
          }),
      }),
    },
    ...extra,
  };
}

const request = (path: string, key?: string, host = HOST) =>
  new Request(`http://${host}:8787${path}`, {
    headers: {
      host: `${host}:8787`,
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      "x-secbot-device": "spoofed",
    },
  });

afterEach(() => vi.restoreAllMocks());

const logged = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe("device check", () => {
  it("parses only well-formed entries", async () => {
    const hash = await sha256Hex("k");
    expect(parseDeviceKeys(`a:owner:${hash}\nbad-entry b:owner:short c:Owner:${hash}`)).toEqual([
      { name: "a", person: "owner", hash },
    ]);
    expect(parseDeviceKeys(undefined)).toEqual([]);
  });

  it("lets a registered key through to its own cell, with the device name set by the worker", async () => {
    const response = await route(request("/v1/cells/owner/status", OWNER_KEY), await env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "owner",
      person: "owner",
      device: "laptop",
      auth: null,
    });
  });

  it.each([
    ["no key", undefined, HOST, 401, "missing_key", null],
    ["an unknown key", "not-registered", HOST, 401, "unknown_key", null],
    ["another person's key", SECOND_KEY, HOST, 403, "other_person", "phone"],
    ["a public host name", OWNER_KEY, "203.0.113.9", 403, "not_private_host", null],
  ] as const)("refuses %s and logs it", async (_label, key, host, status, reason, device) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await route(request("/v1/cells/owner/session", key, host), await env());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: `refused: ${reason}` });
    const lines = logged(log);
    expect(lines).toEqual([
      {
        event: "cli.refused",
        cell: "owner",
        reason,
        device,
        route: "/v1/cells/owner",
        host_prefix: host.slice(0, 3),
      },
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(OWNER_KEY);
    expect(text).not.toContain(await sha256Hex(OWNER_KEY));
    expect(text).not.toContain(HOST);
  });

  it("refuses a revoked key once its entry is removed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const revoked = await env({
      SECBOT_DEVICE_KEYS: `phone:second:${await sha256Hex(SECOND_KEY)}`,
    });
    expect((await route(request("/v1/cells/owner/status", OWNER_KEY), revoked)).status).toBe(401);
  });

  it("refuses the owner's key on the second person's lead", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await checkDevice(
      request("/v1/cells/second/session", OWNER_KEY),
      await env(),
      "second",
    );
    expect(result).toEqual({ ok: false, status: 403, reason: "other_person" });
  });

  it("refuses everything when no private host name is configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const open = await env({ SECBOT_PRIVATE_HOSTS: "" });
    expect((await route(request("/v1/cells/owner/status", OWNER_KEY), open)).status).toBe(403);
  });

  it("answers 404 for an unknown cell without a device check", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      (await route(request("/v1/cells/household/status", OWNER_KEY), await env())).status,
    ).toBe(404);
    expect(log).not.toHaveBeenCalled();
  });
});
