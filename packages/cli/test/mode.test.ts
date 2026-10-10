// `secbot mode` against the fake cell (operator key), the reviewer row of `secbot model list`, and
// a shadow verdict in `secbot activity`: the exact text, usage errors with exit 2, the missing
// operator key with exit 1, the key never printed, and no line over 80 columns.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-cli-mode-"));
});
afterEach(async () => {
  await cell?.close();
  cell = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function setup(withOperatorKey = true) {
  const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
  const quiet: Io = { stdout: () => {}, stderr: () => {}, lines: async function* () {} };
  expect(await run(["device", "new", "laptop"], { environment, io: quiet })).toBe(0);
  const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
  cell = await startFakeCell(device.key);
  environment.env.SECBOT_CELL_URL = cell.url;
  if (withOperatorKey) environment.env.SECBOT_OPERATOR_KEY = cell.operatorKey;
  return { environment, fake: cell };
}

async function secbot(
  environment: { env: Record<string, string>; home: string },
  ...argv: string[]
) {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: async function* () {},
  };
  const code = await run(argv, { environment, io });
  return { code, out, err };
}

const fits = (text: string) => text.split("\n").every((line) => line.length <= 80);

describe("secbot mode", () => {
  it("shows, switches, and switches back a person's mode with the operator key", async () => {
    const { environment, fake } = await setup();
    expect(await secbot(environment, "mode", "show", "sam")).toEqual({
      code: 0,
      out: "sam  mode shadow  since 8 Oct 18:20  decision model jev\n",
      err: "",
    });
    expect(await secbot(environment, "mode", "set", "sam", "enforce")).toEqual({
      code: 0,
      out: "sam now runs in enforce mode\n",
      err: "",
    });
    expect((await secbot(environment, "mode", "set", "sam", "enforce")).out).toBe(
      "sam already runs in enforce mode\n",
    );
    expect(await secbot(environment, "mode", "decision", "sam", "clef")).toEqual({
      code: 0,
      out: "sam now uses the clef decision model from the next call\n",
      err: "",
    });
    const sent = fake.calls.filter((call) => call.path.startsWith("/ops/"));
    expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /ops/mode?cell=sam",
      "PUT /ops/mode?cell=sam",
      "PUT /ops/mode?cell=sam",
      "PUT /ops/decision-model?cell=sam",
    ]);
    expect(sent.map((call) => call.body)).toEqual([
      undefined,
      { mode: "enforce" },
      { mode: "enforce" },
      { adapter: "clef" },
    ]);
    // The operator key goes in its header only, never in a URL, a device header, or output.
    expect(sent.every((call) => call.auth === undefined)).toBe(true);
    expect(JSON.stringify(sent.map((call) => call.path))).not.toContain(fake.operatorKey);
  });

  it("exits 2 on usage errors and sends nothing", async () => {
    const { environment, fake } = await setup();
    for (const argv of [
      ["mode"],
      ["mode", "show"],
      ["mode", "set", "sam"],
      ["mode", "set", "sam", "off"],
      ["mode", "decision", "sam", "gpt"],
      ["mode", "flip", "sam"],
    ]) {
      const result = await secbot(environment, ...argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.out).toBe("");
      expect(fits(result.err)).toBe(true);
    }
    expect(fake.calls.filter((call) => call.path.startsWith("/ops/"))).toEqual([]);
  });

  it("exits 1 with the operator-key error when no operator key is set", async () => {
    const { environment } = await setup(false);
    const result = await secbot(environment, "mode", "set", "sam", "enforce");
    expect(result.code).toBe(1);
    expect(result.err).toContain("no operator key");
    expect(fits(result.err)).toBe(true);
  });

  it("refuses a wrong operator key without printing it", async () => {
    const { environment } = await setup();
    environment.env.SECBOT_OPERATOR_KEY = "wrong-operator-key-000000"; // gitleaks:allow (fake test key)
    const result = await secbot(environment, "mode", "show", "sam");
    expect(result.code).toBe(1);
    expect(result.err).toBe("secbot: the cell refused the operator key (refused: operator_key)\n");
    expect(result.err).not.toContain("wrong-operator-key");
  });
});

describe("the reviewer and shadow verdicts in the person's views", () => {
  it("lists the reviewer role with its model", async () => {
    const { environment } = await setup();
    const result = await secbot(environment, "model", "list");
    expect(result.out).toContain("reviewer  anthropic/claude-sonnet-5.5  (release default)\n");
  });

  it("shows a shadow would-block row with its reason under it", async () => {
    const { environment, fake } = await setup();
    fake.activity = {
      person: "owner",
      month: "2026-10",
      timeZone: "UTC",
      total: 2,
      next: null,
      records: [
        {
          at: Date.UTC(2026, 9, 8, 11, 20),
          agent: "lead",
          tool: "set_reminder",
          verdict: "would block",
          layer: "reviewer",
          reason: "shadow: reminder text holds a card number; the call ran",
          cost: 0.0061,
          mode: "shadow",
        },
        {
          at: Date.UTC(2026, 9, 8, 9, 15),
          agent: "household",
          tool: "pay_test",
          verdict: "refused",
          layer: "rule",
          reason: "owner rule: all pay tools (any) -> prohibit",
          cost: 0,
          mode: "shadow",
        },
      ],
    };
    const result = await secbot(environment, "activity");
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines.slice(2, 7)).toEqual([
      "TIME   AGENT      TOOL OR JOB              VERDICT       LAYER          COST",
      "11:20  lead       set_reminder             would block   reviewer  $0.0061",
      "         shadow: reminder text holds a card number; the call ran",
      "09:15  household  pay_test                 refused       rule      $0.0000",
      "         owner rule: all pay tools (any) -> prohibit",
    ]);
    expect(fits(result.out)).toBe(true);
  });
});
