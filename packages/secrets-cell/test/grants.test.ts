// Grants inside the owner's allowlist, per agent: a grant inside the allowlist is stored; one
// outside it, or naming another person's secret, is refused; only the granted agent gets the
// value; a broker secret is never returned; each refusal logs exactly one `secret.refused` with no
// value; the cell answers refusals as 400 and a missing key helper as 503.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { testCustody } from "../src/key-custody.ts";
import { SecretsCell } from "../src/secrets-cell.ts";

const VALUE = "test-secret-value-1234"; // gitleaks:allow (fake test value)
const TOKEN = "health-token-abcdef-0001"; // gitleaks:allow (fake test token)

const cells: SecretsCell[] = [];
afterEach(async () => {
  for (const cell of cells.splice(0)) await cell.close();
  vi.restoreAllMocks();
});

function setup() {
  const cell = new SecretsCell(
    { storage: new FakeCelldStorage() },
    {},
    { custody: testCustody(), version: "v0.0.0-test" },
  );
  cells.push(cell);
  return cell;
}

const events = (calls: readonly unknown[][]) =>
  calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

describe("grants and the allowlist", () => {
  it("stores a grant inside the allowlist and refuses one outside it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = setup();
    await cell.add({ person: "owner", name: "test-secret", value: VALUE });
    await cell.add({ person: "second", name: "their-secret", value: "second-value-0001" });
    expect(
      await cell.allowlist({
        person: "owner",
        secret: "test-secret",
        agent: "research",
        action: "add",
      }),
    ).toEqual({
      ok: true,
      value: { changed: true, revoked: false },
    });
    expect(await cell.grant({ person: "owner", secret: "test-secret", agent: "research" })).toEqual(
      {
        ok: true,
        value: { granted: true },
      },
    );
    expect(await cell.grant({ person: "owner", secret: "test-secret", agent: "health" })).toEqual({
      ok: false,
      status: 400,
      error: "test-secret is not in the owner's allowlist for health",
    });
    // Another person's secret is not in this person's namespace.
    expect(
      await cell.grant({ person: "owner", secret: "their-secret", agent: "research" }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "no secret named their-secret",
    });
    const refused = events(warn.mock.calls).filter((event) => event.event === "secret.refused");
    expect(refused).toHaveLength(2);
    expect(refused.map((event) => event.action)).toEqual(["grant", "grant"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(VALUE);
  });

  it("gives the value to the granted agent only, and logs one secret.refused per refusal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = setup();
    await cell.add({ person: "owner", name: "test-secret", value: VALUE });
    await cell.add({ person: "owner", name: "other-secret", value: "other-value-0001" });
    await cell.allowlist({
      person: "owner",
      secret: "test-secret",
      agent: "research",
      action: "add",
    });
    await cell.grant({ person: "owner", secret: "test-secret", agent: "research" });
    expect(await cell.get({ person: "owner", agent: "research", name: "test-secret" })).toEqual({
      ok: true,
      value: { value: VALUE },
    });
    const refusals = [
      await cell.get({ person: "owner", agent: "lead", name: "test-secret" }),
      await cell.get({ person: "owner", agent: "household", name: "test-secret" }),
      await cell.get({ person: "owner", agent: "research", name: "other-secret" }),
      await cell.get({ person: "second", agent: "research", name: "test-secret" }),
    ];
    expect(refusals).toEqual([
      { ok: false, status: 400, error: "test-secret is not granted to lead" },
      { ok: false, status: 400, error: "test-secret is not granted to household" },
      { ok: false, status: 400, error: "other-secret is not granted to research" },
      // The second person has no such secret: the agent reads the same refusal as for an
      // ungranted one, so it cannot learn which names exist; the log keeps the difference.
      { ok: false, status: 400, error: "test-secret is not granted to research" },
    ]);
    const refused = events(warn.mock.calls).filter((event) => event.event === "secret.refused");
    expect(refused).toHaveLength(4);
    for (const event of refused) {
      expect(event).toMatchObject({ cell: "secrets", action: "get" });
      expect(
        Object.keys(event)
          .filter((key) => key !== "detail")
          .sort(),
      ).toEqual(["action", "agent", "cell", "event", "level", "person", "reason", "secret"].sort());
    }
    expect(refused.map((event) => event.detail ?? null)).toEqual([
      null,
      null,
      null,
      "no such secret",
    ]);
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(VALUE);
    expect(logged).not.toContain("other-value-0001");
  });

  it("revokes a secret's grants when it is added again as another kind", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = setup();
    const broker = {
      kind: "health" as const,
      url: "https://health.example.test/api",
      header: "authorization",
    };
    await cell.add({ person: "owner", name: "health-test", value: TOKEN, broker });
    await cell.allowlist({
      person: "owner",
      secret: "health-test",
      agent: "health",
      action: "add",
    });
    await cell.grant({ person: "owner", secret: "health-test", agent: "health" });
    // Added again with the broker target forgotten: the agent must not read the token.
    await cell.add({ person: "owner", name: "health-test", value: TOKEN });
    expect(await cell.get({ person: "owner", agent: "health", name: "health-test" })).toEqual({
      ok: false,
      status: 400,
      error: "health-test is not granted to health",
    });
    // The same kind again keeps the grants.
    await cell.add({ person: "owner", name: "health-test", value: TOKEN, broker });
    await cell.grant({ person: "owner", secret: "health-test", agent: "health" });
    await cell.add({ person: "owner", name: "health-test", value: TOKEN, broker });
    const listed = await cell.list({ person: "owner" });
    expect(listed.ok && listed.value.find((each) => each.name === "health-test")?.grants).toEqual([
      "health",
    ]);
  });

  it("replaces a secret of another kind and revokes its grants in one transaction", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new FakeCelldStorage();
    const cell = new SecretsCell({ storage }, {}, { custody: testCustody(), version: "v0.0.0-test" });
    cells.push(cell);
    const broker = {
      kind: "health" as const,
      url: "https://health.example.test/api",
      header: "authorization",
    };
    await cell.add({ person: "owner", name: "health-test", value: TOKEN, broker });
    await cell.allowlist({
      person: "owner",
      secret: "health-test",
      agent: "health",
      action: "add",
    });
    await cell.grant({ person: "owner", secret: "health-test", agent: "health" });
    const kindAndGrants = async () => {
      const listed = await cell.list({ person: "owner" });
      const entry = listed.ok ? listed.value.find((each) => each.name === "health-test") : undefined;
      return [entry?.kind, entry?.grants];
    };
    // The process fails after the row is written and before the grants are deleted.
    const exec = storage.sql.exec;
    let failed = false;
    storage.sql.exec = (query, ...bindings) => {
      if (!failed && query === "DELETE FROM grants WHERE person = ? AND secret = ?") {
        failed = true;
        throw new Error("induced failure between the two writes");
      }
      return exec(query, ...bindings);
    };
    const first = await cell.add({ person: "owner", name: "health-test", value: TOKEN });
    expect(failed).toBe(true);
    expect(first.ok).toBe(false);
    // Neither write is visible: still a broker secret, still granted.
    expect(await kindAndGrants()).toEqual(["health", ["health"]]);
    // A retry sees the kind change and performs both.
    expect(await cell.add({ person: "owner", name: "health-test", value: TOKEN })).toMatchObject({
      ok: true,
    });
    expect(await kindAndGrants()).toEqual(["secret", []]);
    expect(await cell.get({ person: "owner", agent: "health", name: "health-test" })).toEqual({
      ok: false,
      status: 400,
      error: "health-test is not granted to health",
    });
  });

  it("logs a name that fails its check only by its length", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = setup();
    const pasted = "Pasted Secret Value 1234!"; // gitleaks:allow (fake test value)
    await cell.add({ person: "owner", name: pasted, value: VALUE });
    const refused = events(warn.mock.calls).filter((event) => event.event === "secret.refused");
    expect(refused).toEqual([
      expect.objectContaining({ secret: `<invalid, ${pasted.length} chars>` }),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(pasted);
  });

  it("never returns a broker secret, revokes on allowlist removal, and lists without values", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = setup();
    await cell.add({
      person: "owner",
      name: "health-test",
      value: TOKEN,
      broker: { kind: "health", url: "https://health.example.test/api", header: "authorization" },
    });
    await cell.add({ person: "owner", name: "test-secret", value: VALUE });
    for (const [secret, agent] of [
      ["health-test", "health"],
      ["test-secret", "research"],
    ] as const) {
      await cell.allowlist({ person: "owner", secret, agent, action: "add" });
      await cell.grant({ person: "owner", secret, agent });
    }
    expect(await cell.get({ person: "owner", agent: "health", name: "health-test" })).toEqual({
      ok: false,
      status: 400,
      error: "health-test is used only through the broker",
    });
    // The redactor learns the plain secret, never the broker token.
    expect(await cell.redactionValues({ person: "owner" })).toEqual({
      ok: true,
      value: { values: [VALUE] },
    });
    const listed = await cell.list({ person: "owner" });
    expect(listed.ok && listed.value.map((s) => [s.name, s.kind, s.grants, s.allowed])).toEqual([
      ["health-test", "health", ["health"], ["health"]],
      ["test-secret", "secret", ["research"], ["research"]],
    ]);
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(
      await cell.allowlist({
        person: "owner",
        secret: "test-secret",
        agent: "research",
        action: "remove",
      }),
    ).toEqual({ ok: true, value: { changed: true, revoked: true } });
    expect(await cell.get({ person: "owner", agent: "research", name: "test-secret" })).toEqual({
      ok: false,
      status: 400,
      error: "test-secret is not granted to research",
    });
    expect(await cell.revoke({ person: "owner", secret: "health-test", agent: "health" })).toEqual({
      ok: true,
      value: { revoked: true },
    });
  });

  it("refuses a value too short to redact, a bad name, and a broker target with a query", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cell = setup();
    expect(await cell.add({ person: "owner", name: "short", value: "abc" })).toMatchObject({
      ok: false,
      status: 400,
      error: "a secret value is 8 to 4096 characters",
    });
    expect(await cell.add({ person: "owner", name: "Bad Name", value: VALUE })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await cell.add({
        person: "owner",
        name: "health-test",
        value: TOKEN,
        broker: {
          kind: "health",
          url: "https://health.example.test/?key=1",
          header: "authorization",
        },
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: "a broker target needs an http or https address",
    });
  });

  it("answers 503 and logs the reason when the key helper is not usable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cell = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      {
        custody: {
          health: async () => ({ ok: false, reason: "key file missing" }),
          currentKeyId: async () => "k1",
          deriveKey: async () => new Uint8Array(32),
          rotate: async () => "k1",
        },
      },
    );
    cells.push(cell);
    expect(await cell.list({ person: "owner" })).toEqual({
      ok: false,
      status: 503,
      error: "secrets cell unavailable",
    });
    await expect(cell.status()).rejects.toThrow(
      "the secrets cell refused to start: key file missing",
    );
    const logged = events(error.mock.calls);
    expect(logged.filter((event) => event.event === "secrets.refused_start")[0]).toMatchObject({
      reason: "key file missing",
    });
  });
});
