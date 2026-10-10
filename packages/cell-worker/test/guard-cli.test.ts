// The real `secbot` command line against the worker's routes and real person cells on the
// stand-in (no network): the first-run rules list, add and remove, the refused looser rule on
// stderr with exit 1, and the activity list after one refused and one allowed call.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { until } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  workerFetch,
} from "./guard-setup.ts";

let dir: string;
let s: GuardSetup | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-guard-cli-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
});
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Runs `secbot <argv>` in process against the worker; returns the exit code and both streams. */
async function secbot(setup: GuardSetup, ...argv: string[]) {
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
  const environment = {
    env: {
      SECBOT_CONFIG_DIR: dir,
      SECBOT_CELL_URL: `http://${HOST}`,
      SECBOT_OPERATOR_KEY: OPERATOR_KEY,
    },
    home: dir,
  };
  const code = await run(argv, { environment, io, fetch: workerFetch(setup) });
  return { code, out, err };
}

const FIRST_RUN = [
  "OWNER RULES (you cannot loosen these)",
  "------------------------------------------------------------------------------",
  "AGENT   TOOL               MATCH                          VERDICT",
  "all     pay tools          any                            prohibit",
  String.raw`all     set_reminder       text ~ /\b\d(?:[ \-\u2010-\u2015]?\d){12,18}\b/i`,
  "                                                          ask first",
  String.raw`all     search_history     query ~ /\b(?:password|passcode|pin|token|api[ _\-]?k`,
  String.raw`                           ey)\b/i                        ask first`,
  "",
  "YOUR RULES",

  "------------------------------------------------------------------------------",
  "AGENT   TOOL               MATCH                          VERDICT",
  "all     handoff            any                            permit",
  "all     household_change   any                            permit",
  "all     set_reminder       any                            permit",
  "all     search_history     any                            permit",
  "",
].join("\n");

const fits = (text: string) => text.split("\n").every((line) => line.length <= 80);

describe("secbot rules against the cell routes", () => {
  it("lists a new person's rules, and add and remove change the list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await guardSetup();
    expect(await secbot(s, "rules", "list")).toEqual({ code: 0, out: FIRST_RUN, err: "" });
    const added = await secbot(
      s,
      "rules",
      "add",
      "lead",
      "set_reminder",
      "prohibit",
      "--regex",
      "text=card",
    );
    expect(added).toEqual({
      code: 0,
      out: "added: lead set_reminder (text ~ /card/i) -> prohibit\n",
      err: "",
    });
    const listed = await secbot(s, "rules", "list");
    expect(listed.out).toContain(
      "lead    set_reminder       text ~ /card/i                 prohibit\n",
    );
    expect(fits(listed.out)).toBe(true);
    const removed = await secbot(
      s,
      "rules",
      "remove",
      "lead",
      "set_reminder",
      "--regex",
      "text=card",
    );
    expect(removed.out).toBe("removed: lead set_reminder (text ~ /card/i) -> prohibit\n");
    expect((await secbot(s, "rules", "list")).out).toBe(FIRST_RUN);
  });

  it("refuses a looser rule on stderr with exit 1, and accepts one inside the owner's rules", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await guardSetup();
    const owner = await secbot(
      s,
      "rules",
      "add",
      "all",
      "handoff",
      "ask-first",
      "--exact",
      "specialist=developer",
      "--owner",
      "--person",
      "owner",
    );
    expect(owner).toEqual({
      code: 0,
      out: "added: all handoff (specialist = developer) -> ask first\n",
      err: "",
    });
    const refused = await secbot(
      s,
      "rules",
      "add",
      "lead",
      "handoff",
      "permit",
      "--exact",
      "specialist=developer",
    );
    expect(refused).toEqual({
      code: 1,
      out: "",
      err: [
        "secbot: refused: this rule is looser than an owner rule:",
        "  all handoff (specialist = developer) -> ask first",
        "  Your rules can be stricter than the owner's rules, never looser.",
        "",
      ].join("\n"),
    });
    const accepted = await secbot(
      s,
      "rules",
      "add",
      "lead",
      "handoff",
      "permit",
      "--exact",
      "specialist=research",
    );
    expect(accepted).toEqual({
      code: 0,
      out: "added: lead handoff (specialist = research) -> permit\n",
      err: "",
    });
    const listed = await secbot(s, "rules", "list");
    expect(listed.out).toContain(
      "all     handoff            specialist = developer         ask first\n",
    );
  });
});

describe("secbot activity against the cell routes", () => {
  it("lists a refused and an allowed call with time, agent, tool, verdict, layer, and reason, secrets redacted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    s = await guardSetup();
    const setup = s;
    expect(
      (
        await secbot(
          setup,
          "rules",
          "add",
          "lead",
          "search_history",
          "prohibit",
          "--exact",
          "query=bank",
        )
      ).code,
    ).toBe(0);
    const secret = "sk-test-0123456789abcdefghijklmnop"; // gitleaks:allow (fake test token)
    const cell = setup.cells.get("owner");
    const call = (query: string) =>
      `CALL search_history ${JSON.stringify({ query, api_key: secret })}`;
    await cell?.submitInput("owner", call("bank"), "guard-cli-1");
    await cell?.submitInput("owner", call("kale"), "guard-cli-2");
    const harness = setup.harness("owner");
    await until(async () => (await harness.activity()).total === 2);
    await harness.harness.waitForIdle(BACKGROUND_CONTEXT);

    const result = await secbot(setup, "activity");
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const lines = result.out.split("\n");
    expect(lines[0]).toMatch(/^ACTIVITY {2}owner {2}\w+ \d{4} +\[ total: \$0\.00 \]$/);
    expect(lines[0]).toHaveLength(78);
    expect(lines[2]).toBe(
      "TIME   AGENT      TOOL OR JOB              VERDICT       LAYER       COST",
    );
    // Newest first: the allowed call, then the refused one; each with its reason below.
    expect(lines[3]).toMatch(
      /^\d\d:\d\d {2}lead {7}search_history {11}allowed {7}rule {6}\$0\.0000$/,
    );
    expect(lines[4]).toBe("         your rule: all search_history (any) -> permit");
    expect(lines[5]).toMatch(
      /^\d\d:\d\d {2}lead {7}search_history {11}refused {7}rule {6}\$0\.0000$/,
    );
    expect(lines[6]).toBe("         your rule: lead search_history (query = bank) -> prohibit");
    expect(lines[7]).toMatch(
      /^showing 2 of 2 this month; older: secbot activity --month \d{4}-\d\d$/,
    );
    expect(fits(result.out)).toBe(true);
    expect(result.out).not.toContain(secret);
    // The stored records and the log lines hold no secret either.
    const stored = JSON.stringify(await harness.activity());
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    const verdicts = log.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as { event?: string };
        } catch {
          return {};
        }
      })
      .filter((event) => event.event === "guard.verdict");
    expect(verdicts).toHaveLength(2);
  });
});
