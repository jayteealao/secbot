// The real `secbot` command line against the worker's routes and real person cells on the
// stand-in, with the stub Decisions API on 127.0.0.1 and a faux reviewer (no outside call): the
// reviewer role in `secbot model list` and `set`; a shadow would-block row and a rule refusal in
// `secbot activity`; and `secbot mode` with the operator key, then the next marked call enforced,
// while a device key cannot switch. With SECBOT_EVIDENCE_DIR set, each command's stdout, stderr,
// and exit code are written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionModels } from "@secbot/cell-harness";
import { reviewerResponder, until, verdictJson } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  riskyAt,
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  scripted,
  workerFetch,
} from "./guard-setup.ts";

const DECISIONS_KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)

let dir: string;
let stub: StubOpenRouter;
let s: GuardSetup | undefined;
/** What the faux reviewer answers. */
let verdict = verdictJson("block", "reminder text holds a card number");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-mode-cli-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  stub = await startStubOpenRouter();
  stub.decision = riskyAt(0.9);
  verdict = verdictJson("block", "reminder text holds a card number");
});
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  await stub.close();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function openSetup(): Promise<GuardSetup> {
  s = await guardSetup(undefined, {
    respond: reviewerResponder(() => verdict, scripted),
    guard: { decision: createDecisionModels({ apiKey: DECISIONS_KEY, baseUrl: stub.origin }) },
  });
  return s;
}

/** Runs `secbot <argv>` in process against the worker; returns the exit code and both streams. */
async function secbot(setup: GuardSetup, operatorKey: string | undefined, ...argv: string[]) {
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
  const env: Record<string, string> = {
    SECBOT_CONFIG_DIR: dir,
    SECBOT_CELL_URL: `http://${HOST}`,
  };
  if (operatorKey !== undefined) env.SECBOT_OPERATOR_KEY = operatorKey;
  const code = await run(argv, { environment: { env, home: dir }, io, fetch: workerFetch(setup) });
  return { code, out, err };
}

/** Writes one command's output for verify when SECBOT_EVIDENCE_DIR is set. */
async function evidence(
  name: string,
  argv: string,
  result: { code: number; out: string; err: string },
) {
  const target = process.env.SECBOT_EVIDENCE_DIR;
  if (target === undefined || target === "") return;
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, name),
    `$ secbot ${argv}\n${result.out}${result.err === "" ? "" : `[stderr]\n${result.err}`}[exit ${result.code}]\n`,
  );
}

const fits = (text: string) =>
  text.split("\n").every((line) => line.length <= 80 && !line.includes("\u001b"));

let requestNo = 0;
async function agentCall(setup: GuardSetup, tool: string, args: Record<string, unknown>) {
  const before = (await setup.harness("owner").activity()).total;
  await setup.cells
    .get("owner")
    ?.submitInput("owner", `CALL ${tool} ${JSON.stringify(args)}`, `mode-cli-${++requestNo}`);
  await until(async () => (await setup.harness("owner").activity()).total > before);
}

describe("the reviewer role in secbot model", () => {
  it("lists the reviewer with Claude Sonnet 5.5, and set changes it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const setup = await openSetup();
    const listed = await secbot(setup, undefined, "model", "list");
    await evidence("model-list.txt", "model list", listed);
    expect(listed.code).toBe(0);
    expect(listed.out.split("\n").at(-2)).toBe(
      "reviewer   anthropic/claude-sonnet-5.5  (release default)",
    );
    const set = await secbot(
      setup,
      undefined,
      "model",
      "set",
      "reviewer",
      "anthropic/claude-haiku-4.5",
    );
    await evidence("model-set-reviewer.txt", "model set reviewer anthropic/claude-haiku-4.5", set);
    expect(set).toEqual({
      code: 0,
      out: "reviewer now uses anthropic/claude-haiku-4.5 from its next turn\n",
      err: "",
    });
    const after = await secbot(setup, undefined, "model", "list");
    expect(after.out).toContain("reviewer   anthropic/claude-haiku-4.5  (changed)\n");
    expect(fits(listed.out) && fits(after.out)).toBe(true);
  });
});

describe("shadow verdicts in secbot activity", () => {
  it("shows the marked call the reviewer would block as run, and the prohibit match as refused", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setup = await openSetup();
    const rule = await secbot(
      setup,
      undefined,
      "rules",
      "add",
      "lead",
      "search_history",
      "prohibit",
      "--exact",
      "query=bank",
    );
    expect(rule.code).toBe(0);
    await agentCall(setup, "set_reminder", { text: "pay with card 4111", at: "09:00" });
    await agentCall(setup, "search_history", { query: "bank" });
    const result = await secbot(setup, undefined, "activity");
    await evidence("activity-shadow.txt", "activity", result);
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines[3]).toMatch(
      /^\d\d:\d\d {2}lead {7}search_history {11}refused {7}rule {6}\$0\.0000$/,
    );
    expect(lines[4]).toBe("         your rule: lead search_history (query = bank) -> prohibit");
    expect(lines[5]).toMatch(
      /^\d\d:\d\d {2}lead {7}set_reminder {13}would block {3}reviewer {2}\$\d\.\d{4}$/,
    );
    expect(lines[6]).toBe("         shadow: reminder text holds a card number; the call ran");
    expect(fits(result.out)).toBe(true);
    // The reminder ran: the lead got its result, not a block.
    const results = setup.gateway.requests.filter(
      (request) => request.role === "lead" && request.last?.role === "toolResult",
    );
    expect(results[0]?.lastText).not.toContain("Tool call blocked");
    expect(results[1]?.lastText).toContain("Tool call blocked");
  });
});

describe("secbot mode with the operator key", () => {
  it("shows a fresh cell in shadow, switches it to enforce, and the next marked call is refused; a device key cannot switch", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setup = await openSetup();
    const shown = await secbot(setup, OPERATOR_KEY, "mode", "show", "owner");
    await evidence("mode-show.txt", "mode show owner", shown);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(
      /^owner {2}mode shadow {2}since \d{1,2} \w{3} \d\d:\d\d {2}decision model jev\n$/,
    );

    // Only the device key: the operator routes refuse it, and the mode stays shadow.
    const byDevice = await secbot(setup, KEY, "mode", "set", "owner", "enforce");
    await evidence(
      "mode-set-device-refused.stderr.txt",
      "mode set owner enforce (device key)",
      byDevice,
    );
    expect(byDevice).toEqual({
      code: 1,
      out: "",
      err: "secbot: the cell refused the operator key (refused: operator_key)\n",
    });
    expect((await setup.harness("owner").guardMode()).mode).toBe("shadow");

    const set = await secbot(setup, OPERATOR_KEY, "mode", "set", "owner", "enforce");
    await evidence("mode-set-enforce.txt", "mode set owner enforce", set);
    expect(set).toEqual({ code: 0, out: "owner now runs in enforce mode\n", err: "" });

    verdict = verdictJson("block", "reminder text holds a card number");
    await agentCall(setup, "set_reminder", { text: "pay with card 4111", at: "09:00" });
    const result = await secbot(setup, undefined, "activity");
    await evidence("activity-enforce.txt", "activity", result);
    const lines = result.out.split("\n");
    expect(lines[3]).toMatch(
      /^\d\d:\d\d {2}lead {7}set_reminder {13}refused {7}reviewer {2}\$\d\.\d{4}$/,
    );
    expect(lines[4]).toBe("         reviewer: reminder text holds a card number");
    expect(lines[5]).toMatch(/^\d\d:\d\d {2}owner {6}mode {21}switched {6}guard {5}\$0\.0000$/);
    expect(lines[6]).toBe("         mode: shadow -> enforce");
    expect(fits(result.out)).toBe(true);
    expect(`${shown.out}${set.out}${byDevice.err}${result.out}`).not.toContain(OPERATOR_KEY);
  });
});
