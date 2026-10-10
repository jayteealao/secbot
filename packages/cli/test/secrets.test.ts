// `secbot secrets` against the fake cell: the list, a grant and a revoke with the device key, and
// the owner's add, allowlist, and rotate with the operator key. Every text is the visual contract's,
// line by line; a refusal goes to stderr with exit 1, a usage error exits 2, the value typed on
// standard input is sent once and never printed, no line passes 80 columns, and no escape
// character is written.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLines } from "../src/commands/secrets.ts";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-secrets-"));
});
afterEach(async () => {
  await cell?.close();
  cell = undefined;
  await rm(dir, { recursive: true, force: true });
});

const VALUE = "test-secret-value-0123456789"; // gitleaks:allow (fake test value)
const RULE = "-".repeat(78);

function testIo(input: readonly string[] = []) {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: async function* () {
      yield* input;
    },
  };
  return { io, out: () => out, err: () => err };
}

async function setup() {
  const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
  expect(await run(["device", "new", "laptop"], { environment, io: testIo().io })).toBe(0);
  const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
  cell = await startFakeCell(device.key);
  environment.env.SECBOT_CELL_URL = cell.url;
  environment.env.SECBOT_OPERATOR_KEY = cell.operatorKey;
  return { environment, fake: cell };
}

async function secbot(
  environment: { env: Record<string, string>; home: string },
  argv: string[],
  input: readonly string[] = [],
) {
  const { io, out, err } = testIo(input);
  const code = await run(argv, { environment, io });
  return { code, out: out(), err: err() };
}

/** Every line at most 80 columns and no escape character (no color, no control codes). */
const plainText = (text: string) =>
  text.split("\n").every((line) => line.length <= 80) && !text.includes("\u001b");

describe("secbot secrets", () => {
  it("lists a person's secrets with kinds and grants, and says when there are none", async () => {
    const { environment, fake } = await setup();
    const empty = await secbot(environment, ["secrets", "list"]);
    expect(empty).toEqual({
      code: 0,
      out: ["SECRETS  owner", RULE, "no secrets yet", ""].join("\n"),
      err: "",
    });
    fake.secrets = [
      { name: "test-secret", kind: "secret", grants: ["research"] },
      { name: "health-test", kind: "health", grants: ["health"] },
    ];
    const listed = await secbot(environment, ["secrets", "list", "--person", "sam"]);
    expect(listed.code).toBe(0);
    expect(listed.out.split("\n")).toEqual([
      "SECRETS  sam",
      RULE,
      "NAME              KIND         GRANTED TO",
      "test-secret       secret       research",
      "health-test       health       health",
      "",
    ]);
    expect(plainText(listed.out)).toBe(true);
    // The person's own list goes with the device key, another person's with the operator key.
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/cells/owner/secrets",
      "GET /ops/secrets?cell=sam",
    ]);
  });

  it("lists an ungranted secret with a dash", () => {
    expect(listLines("sam", [{ name: "spare", kind: "production", grants: [] }])).toEqual([
      "SECRETS  sam",
      RULE,
      "NAME              KIND         GRANTED TO",
      "spare             production   -",
    ]);
  });

  it("grants and revokes a secret for one agent with the device key", async () => {
    const { environment, fake } = await setup();
    expect(await secbot(environment, ["secrets", "grant", "test-secret", "research"])).toEqual({
      code: 0,
      out: "[ granted ] test-secret -> research\n",
      err: "",
    });
    expect(await secbot(environment, ["secrets", "revoke", "test-secret", "research"])).toEqual({
      code: 0,
      out: "[ revoked ] test-secret -> research\n",
      err: "",
    });
    expect(fake.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/v1/cells/owner/secrets/grants", { secret: "test-secret", agent: "research" }],
      ["DELETE", "/v1/cells/owner/secrets/grants", { secret: "test-secret", agent: "research" }],
    ]);
  });

  it("prints each refusal on stderr with exit 1", async () => {
    const { environment, fake } = await setup();
    for (const reason of [
      "test-secret is not in the owner's allowlist for research",
      "no secret named test-secret",
      "no agent named builder",
    ]) {
      fake.secretsFailure = [400, `refused: ${reason}`];
      expect(await secbot(environment, ["secrets", "grant", "test-secret", "research"])).toEqual({
        code: 1,
        out: "",
        err: `secbot: refused: ${reason}\n`,
      });
    }
    fake.secretsFailure = [503, "refused: secrets cell unavailable"];
    expect(await secbot(environment, ["secrets", "list"])).toEqual({
      code: 1,
      out: "",
      err: "secbot: refused: secrets cell unavailable\n",
    });
  });

  it("adds a secret from standard input and never prints the value", async () => {
    const { environment, fake } = await setup();
    const added = await secbot(
      environment,
      ["secrets", "add", "--person", "sam", "test-secret"],
      [VALUE],
    );
    expect(added).toEqual({
      code: 0,
      out: "[ stored ] test-secret for sam under key k1\n",
      err: "",
    });
    const broker = await secbot(
      environment,
      [
        "secrets",
        "add",
        "--person",
        "sam",
        "health-test",
        "--broker",
        "health",
        "--url",
        "http://127.0.0.1:9/health",
        "--header",
        "authorization",
      ],
      [VALUE],
    );
    expect(broker).toEqual({
      code: 0,
      out: "[ stored ] health-test for sam under key k1; used only through the broker\n",
      err: "",
    });
    expect(fake.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", "/ops/secrets?cell=sam", { name: "test-secret", value: VALUE }],
      [
        "PUT",
        "/ops/secrets?cell=sam",
        {
          name: "health-test",
          value: VALUE,
          broker: { kind: "health", url: "http://127.0.0.1:9/health", header: "authorization" },
        },
      ],
    ]);
    // The operator key goes only in its header, and the value only in the request body.
    expect(`${added.out}${added.err}${broker.out}${broker.err}`).not.toContain(VALUE);
    expect(fake.calls.every((call) => !call.path.includes(VALUE))).toBe(true);
  });

  it("refuses an add with no value, half the broker flags, or an unknown broker kind (exit 2)", async () => {
    const { environment, fake } = await setup();
    const none = await secbot(environment, ["secrets", "add", "--person", "sam", "test-secret"]);
    expect(none).toEqual({
      code: 2,
      out: "",
      err: "secbot: send the secret's value on standard input\n",
    });
    const half = await secbot(
      environment,
      ["secrets", "add", "--person", "sam", "h", "--broker", "health"],
      [VALUE],
    );
    expect(half.code).toBe(2);
    expect(half.err).toBe("secbot: a broker secret takes --broker, --url, and --header together\n");
    const kind = await secbot(
      environment,
      ["secrets", "add", "--person", "sam", "h", "--broker", "mail", "--url", "u", "--header", "x"],
      [VALUE],
    );
    expect(kind).toEqual({ code: 2, out: "", err: "secbot: the broker is health or production\n" });
    expect(fake.calls).toEqual([]);
  });

  it("sets the owner's allowlist and says when a removal revoked the grant", async () => {
    const { environment, fake } = await setup();
    const allow = ["secrets", "allowlist", "--person", "sam"];
    expect(await secbot(environment, [...allow, "add", "test-secret", "research"])).toEqual({
      code: 0,
      out: "[ allowed ] sam test-secret -> research\n",
      err: "",
    });
    expect(await secbot(environment, [...allow, "remove", "test-secret", "research"])).toEqual({
      code: 0,
      out: "[ removed ] sam test-secret -> research; its grant was revoked\n",
      err: "",
    });
    expect(fake.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", "/ops/secrets/allowlist?cell=sam", { secret: "test-secret", agent: "research" }],
      ["DELETE", "/ops/secrets/allowlist?cell=sam", { secret: "test-secret", agent: "research" }],
    ]);
  });

  it("rotates the master key and prints the count", async () => {
    const { environment } = await setup();
    expect(await secbot(environment, ["secrets", "rotate"])).toEqual({
      code: 0,
      out: "[ rotated ] 3 secrets re-wrapped under key k2; 0 left under k1\n",
      err: "",
    });
  });

  it("prints the usage for a wrong command with exit 2", async () => {
    const { environment, fake } = await setup();
    for (const argv of [
      ["secrets"],
      ["secrets", "grant", "test-secret"],
      ["secrets", "add", "test-secret"],
      ["secrets", "allowlist", "--person", "sam", "add", "test-secret"],
      ["secrets", "rotate", "now"],
      ["secrets", "list", "--broker", "health"],
    ]) {
      const result = await secbot(environment, argv);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/^secbot: usage: secbot secrets list/);
      expect(plainText(result.err)).toBe(true);
    }
    expect(fake.calls).toEqual([]);
  });
});
