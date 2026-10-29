// The capacity warning through the command line, on the stand-in with the test-cell switch on:
// the operator sets the owner cell's measured number to 1, the lead starts two jobs that hold on
// the slow fixture tool, and `secbot jobs` (run in process, no TTY) prints the approved capacity
// line above the column header with both rows running; the owner got exactly one alert. With
// SECBOT_EVIDENCE_DIR set, the board and the alerts are written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
  until,
} from "@secbot/cell-harness/testing";
import { jobResponder, startJobLine } from "@secbot/cell-harness/testing/responders";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALERT_ENV, incidentStub } from "../../cell-harness/test/outage-fixtures.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { OPERATOR_HEADER } from "../src/internal-rpc.ts";
import { route } from "../src/routes.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  workerFetch,
} from "./guard-setup.ts";

let s: GuardSetup | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

/** Research jobs that call the slow fixture tool once and answer after it. */
const slowJobs: Responder = (request) => {
  if (request.role !== "research") return jobResponder(request);
  return request.last?.role === "toolResult"
    ? fauxAssistantMessage([fauxText("three options")])
    : fauxAssistantMessage([fauxToolCall("fixture_slow_lookup", { topic: "flights" })], {
        stopReason: "toolUse",
      });
};

async function secbot(setup: GuardSetup, ...argv: string[]) {
  dir ??= await mkdtemp(join(tmpdir(), "secbot-capacity-cli-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
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
  const env = { SECBOT_CONFIG_DIR: dir, SECBOT_CELL_URL: `http://${HOST}` };
  const code = await run(argv, { environment: { env, home: dir }, io, fetch: workerFetch(setup) });
  return { code, out, err };
}

const MEASURED_AT = Date.UTC(2026, 9, 29, 12);

describe("the capacity warning through secbot jobs", () => {
  it("prints the approved line above the columns, keeps both jobs running, and alerts once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = incidentStub();
    s = await guardSetup(undefined, {
      respond: slowJobs,
      personEnv: () => ({ SECBOT_TEST_FIXTURES: "1" }),
      cellEnv: ALERT_ENV,
      fetch: stub.fetcher,
    });
    const setup = s;
    const set = await route(
      new Request(`http://${HOST}/ops/capacity?cell=owner`, {
        method: "PUT",
        headers: { [OPERATOR_HEADER]: OPERATOR_KEY },
        body: JSON.stringify({ measured: 1, at: MEASURED_AT }),
      }),
      setup.env,
    );
    expect(set.status).toBe(200);
    const harness = setup.harness("owner");
    const lines = [1, 2]
      .map((n) =>
        startJobLine({
          title: `flights ${n}`,
          brief: `look up flights ${n}`,
          template: "research",
        }),
      )
      .join("\n");
    await (await harness.submit(lines, "start-two")).wait(BACKGROUND_CONTEXT);
    await until(
      async () =>
        Object.values((await harness.board()).jobs).filter((row) => row.status === "running")
          .length === 2,
    );
    await until(() => stub.incidents.length > 0);
    const board = await secbot(setup, "jobs");
    expect(board.code).toBe(0);
    const out = board.out.split("\n");
    const capacity = out.findIndex((line) => line.startsWith("[ 2 jobs at once"));
    expect(out[capacity]).toBe(
      "[ 2 jobs at once; this cell was measured at 1 on 29 Oct ] nothing is held back",
    );
    expect(capacity).toBeGreaterThan(0);
    expect(out.findIndex((line) => line.startsWith("#"))).toBeGreaterThan(capacity);
    const rows = out.filter((line) => /^\s*[12]\s+flights/.test(line));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain("running");
    for (const line of out) expect(line.length).toBeLessThanOrEqual(80);
    expect(stub.incidents).toHaveLength(1);
    expect(stub.incidents[0]?.body.summary).toBe(
      "Secbot owner cell: 2 jobs at once, measured at 1",
    );
    const where = process.env.SECBOT_EVIDENCE_DIR;
    if (where !== undefined && where !== "") {
      await mkdir(where, { recursive: true });
      await writeFile(join(where, "ac-37-board.stdout.txt"), board.out);
      await writeFile(
        join(where, "ac-37-incidents.json"),
        `${JSON.stringify(
          stub.incidents.map((incident) => ({
            summary: incident.body.summary,
            description: incident.body.description,
          })),
          null,
          2,
        )}\n`,
      );
    }
  }, 60_000);
});
