// The real `secbot` command line against the worker's routes and real person cells on the
// stand-in (no network): `secbot cost` after known spend equals that spend by layer and role, a new
// person's limit is $25.00 and the owner's `secbot limits set` applies to the next view, the same
// command with only the device key fails with the limit unchanged, and with a 1-dollar limit the
// alert stand-in receives one alert at each line while `secbot missed` prints the notices once.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSpend } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_ENV, incidentStub } from "../../cell-harness/test/outage-fixtures.ts";
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
  dir = await mkdtemp(join(tmpdir(), "secbot-limits-cli-"));
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
async function secbot(setup: GuardSetup, operatorKey: boolean, ...argv: string[]) {
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
      ...(operatorKey ? { SECBOT_OPERATOR_KEY: OPERATOR_KEY } : {}),
    },
    home: dir,
  };
  const code = await run(argv, { environment, io, fetch: workerFetch(setup) });
  return { code, out, err };
}

const plainText = (text: string) =>
  text.split("\n").every((line) => line.length <= 80) && !text.includes("\u001b");

describe("secbot cost and secbot limits against the cell routes", () => {
  it("shows the month's spend by layer and role, equal to the spend the cell took", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await guardSetup();
    await secbot(s, false, "cost");
    const cell = s.harness("owner");
    await addSpend(cell, 7.9, { role: "lead" });
    await addSpend(cell, 0.41, { role: "lead", layer: "decision" });
    await addSpend(cell, 2.31, { role: "research" });
    await addSpend(cell, 0.27, { role: "research", layer: "reviewer" });
    await addSpend(cell, 0.63, { role: "household" });
    const result = await secbot(s, false, "cost");
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines[2]).toBe("[ month: $11.52 / $25.00 ] [#########...........] 46%");
    expect(lines.slice(4, 8)).toEqual([
      "BY LAYER                     BY ROLE",
      "agent model       $10.84     lead          $8.31",
      "reviewer           $0.27     research      $2.58",
      "decision model     $0.41     household     $0.63",
    ]);
    expect(plainText(result.out)).toBe(true);
  });

  it("starts at $25.00, takes the owner's new limit, and refuses the change without the operator key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await guardSetup();
    const first = await secbot(s, false, "cost");
    expect(first.out.split("\n")[2]).toBe("[ month: $0.00 / $25.00 ] [....................] 0%");
    const refused = await secbot(s, false, "limits", "set", "owner", "40");
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(refused.err).toContain("operator key");
    expect((await secbot(s, false, "cost")).out.split("\n")[2]).toContain("/ $25.00 ]");
    const set = await secbot(s, true, "limits", "set", "owner", "40");
    expect(set).toEqual({
      code: 0,
      out: "owner's monthly limit is now $40.00 from the next call\n",
      err: "",
    });
    expect((await secbot(s, false, "cost")).out.split("\n")[2]).toBe(
      "[ month: $0.00 / $40.00 ] [....................] 0%",
    );
    const person = await secbot(s, true, "cost", "--person", "owner");
    expect(person.out.split("\n")[0]).toMatch(/^COST {2}owner \(operator key\) {2}/);
    expect(person.out).not.toContain(OPERATOR_KEY);
    const bad = await secbot(s, true, "limits", "set", "owner", "0");
    expect(bad.code).toBe(2);
  });

  it("alerts the owner once at each line and prints each notice once in secbot missed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { incidents, fetcher } = incidentStub();
    s = await guardSetup(undefined, { cellEnv: ALERT_ENV, fetch: fetcher });
    expect((await secbot(s, true, "limits", "set", "owner", "1")).code).toBe(0);
    const cell = s.harness("owner");
    const settle = async () => {
      cell.budget.watch.trigger();
      await cell.budget.watch.settled();
    };
    await addSpend(cell, 0.79);
    await settle();
    expect(incidents).toHaveLength(0);
    expect((await secbot(s, false, "missed")).out).toBe("no missed messages\n");
    await addSpend(cell, 0.03);
    await settle();
    expect(incidents.map((incident) => incident.body.summary)).toEqual([
      "Secbot owner cell: 80% of the monthly limit",
    ]);
    const missed = await secbot(s, false, "missed");
    expect(missed.out.split("\n").slice(0, 3)).toEqual([
      "[ 80% of limit ] You have used $0.82 of $1.00 this month. At $1.00,",
      "  hand-offs, routines, and reminders wait. Chat with the lead continues.",
      expect.stringMatching(/^ {2}Your limit resets on \d{1,2} [A-Z][a-z]{2}\.$/),
    ]);
    expect((await secbot(s, false, "missed")).out).toBe("no missed messages\n");
    await addSpend(cell, 0.2);
    await settle();
    await addSpend(cell, 0.1);
    await settle();
    expect(incidents.map((incident) => incident.body.summary)).toEqual([
      "Secbot owner cell: 80% of the monthly limit",
      "Secbot owner cell: monthly limit reached",
    ]);
    const over = await secbot(s, false, "missed");
    expect(over.out.split("\n")[0]).toBe(
      "[ limit reached ] You have used $1.02 of $1.00 this month. Hand-offs,",
    );
    expect(plainText(over.out)).toBe(true);
  });
});
