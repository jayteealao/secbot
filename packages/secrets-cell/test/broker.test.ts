// The broker against a local fake target that checks the token header and echoes it back: the
// secrets cell makes the call with the token, the agent's answer holds no token (AC-40), a path
// that leaves the target is refused before any call, and a redirect is never followed.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { brokerCall, checkRequest } from "../src/broker.ts";
import { testCustody } from "../src/key-custody.ts";
import { SecretsCell } from "../src/secrets-cell.ts";

const TOKEN = "health-token-abcdef-0001"; // gitleaks:allow (fake test token)

let server: Server;
let origin: string;
const seen: { path: string; auth: string | undefined; body: string }[] = [];

beforeEach(async () => {
  seen.length = 0;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      seen.push({ path: request.url ?? "", auth: request.headers.authorization, body });
      if (request.url === "/api/redirect") {
        response.writeHead(302, { location: "https://elsewhere.example.test/steal" });
        response.end();
        return;
      }
      if (request.headers.authorization !== TOKEN) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no token" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      // A careless service that echoes the token it was sent.
      response.end(JSON.stringify({ steps: 8012, echo: `you sent ${TOKEN}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe("brokerCall", () => {
  it("sends the token in the header and redacts it from the answer (AC-40)", async () => {
    const answer = await brokerCall(
      { kind: "health", url: `${origin}/api`, header: "authorization" },
      TOKEN,
      { method: "GET", path: "/steps?day=today" },
    );
    expect(seen).toEqual([{ path: "/api/steps?day=today", auth: TOKEN, body: "" }]);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("8012");
    expect(answer.body).toContain("[redacted]");
    expect(answer.body).not.toContain(TOKEN);
  });

  it("does not follow a redirect with the token", async () => {
    const answer = await brokerCall(
      { kind: "health", url: `${origin}/api`, header: "authorization" },
      TOKEN,
      { method: "GET", path: "/redirect" },
    );
    expect(answer.status).toBe(302);
    expect(seen.map((call) => call.path)).toEqual(["/api/redirect"]);
  });

  it.each(["steps", "//elsewhere.example.test/x", "/../admin", "/a\\b", "/a b"])(
    "refuses the path %s before any call",
    (path) => {
      expect(() => checkRequest({ method: "GET", path })).toThrow(
        "the path must start with / and stay under the service's address",
      );
    },
  );

  it("answers status 0 when the target does not answer", async () => {
    const answer = await brokerCall(
      { kind: "health", url: "http://127.0.0.1:9/api", header: "authorization" },
      TOKEN,
      { method: "GET", path: "/steps" },
    );
    expect(answer).toEqual({ status: 0, body: "The service did not answer." });
  });
});

describe("the secrets cell's broker", () => {
  it("makes the call for the granted agent, and refuses the others (AC-40, AC-38)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      { custody: testCustody(), version: "v0.0.0-test" },
    );
    try {
      await cell.add({
        person: "owner",
        name: "health-test",
        value: TOKEN,
        broker: { kind: "health", url: `${origin}/api`, header: "authorization" },
      });
      await cell.allowlist({
        person: "owner",
        secret: "health-test",
        agent: "health",
        action: "add",
      });
      await cell.grant({ person: "owner", secret: "health-test", agent: "health" });
      const answer = await cell.broker({
        person: "owner",
        agent: "health",
        name: "health-test",
        request: { method: "GET", path: "/steps" },
      });
      expect(answer.ok && answer.value.status).toBe(200);
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
      expect(
        await cell.broker({
          person: "owner",
          agent: "lead",
          name: "health-test",
          request: { method: "GET", path: "/steps" },
        }),
      ).toEqual({ ok: false, status: 400, error: "health-test is not granted to lead" });
      expect(
        await cell.broker({
          person: "owner",
          agent: "health",
          name: "health-test",
          request: { method: "GET", path: "//elsewhere.example.test/x" },
        }),
      ).toEqual({
        ok: false,
        status: 400,
        error: "the path must start with / and stay under the service's address",
      });
      expect(seen).toHaveLength(1);
      const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
      expect(logged).not.toContain(TOKEN);
      const names = log.mock.calls.map(
        (call) => (JSON.parse(String(call[0])) as { event: string }).event,
      );
      expect(names).toContain("secrets.brokered");
    } finally {
      await cell.close();
    }
  });
});
