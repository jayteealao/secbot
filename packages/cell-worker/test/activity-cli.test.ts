// The real `secbot activity` against the worker's routes and real person cells on the stand-in
// (the faux model, the stub Decisions API on 127.0.0.1, a faux reviewer; no outside call): one item
// of each kind (an allowed, a refused, a would-block, a held, an answered, and a lapsed call, a done
// reminder, a done hand-off with its cost, a running and a waiting hand-off) in the designed layout
// under the month's spend; the empty state; records older than 90 days by month; paging; and the
// person check: another person's device key is refused, a device key is not the operator key, and
// the owner reads a person with the operator key. With SECBOT_EVIDENCE_DIR set, each command's
// stdout, stderr, and exit code are written there.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDecisionModels } from "@secbot/cell-harness";
import {
  addSpend,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  loggedEvents,
  reviewerResponder,
  until,
  verdictJson,
} from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRecord } from "../../cell-harness/src/activity.ts";
import {
  riskyAt,
  routineAt,
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { sha256Hex } from "../src/device-auth.ts";
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
const SECOND_KEY = "second-phone-key-0123456789abcdef0123456789abcdef"; // gitleaks:allow (fake test key)
const RULE = "-".repeat(78);

let dir: string;
let stub: StubOpenRouter;
let s: GuardSetup | undefined;
let releaseAll: () => void = () => {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-activity-cli-"));
  await mkdir(join(dir, "second"), { recursive: true });
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  await writeFile(
    join(dir, "second", "device.json"),
    JSON.stringify({ name: "phone", person: "second", key: SECOND_KEY }),
  );
  stub = await startStubOpenRouter();
});
afterEach(async () => {
  releaseAll();
  if (s !== undefined) await closeAll(s);
  s = undefined;
  await stub.close();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The worker with both persons' device keys. */
async function openSetup(
  options: {
    readonly respond?: (request: FauxRequest) => unknown;
    readonly now?: () => number;
  } = {},
): Promise<GuardSetup> {
  s = await guardSetup(undefined, {
    respond: reviewerResponder(
      () => verdictJson("block", "reminder text holds a card number"),
      (options.respond ?? scripted) as typeof scripted,
    ),
    guard: {
      decision: createDecisionModels({ apiKey: DECISIONS_KEY, baseUrl: stub.origin }),
      holdMs: 1_500,
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  Object.assign(s.env, {
    SECBOT_DEVICE_KEYS: `laptop:owner:${await sha256Hex(KEY)}, phone:second:${await sha256Hex(SECOND_KEY)}`,
  });
  return s;
}

/** Runs `secbot <argv>` in process against the worker as `who`'s device. */
async function secbot(
  setup: GuardSetup,
  who: { readonly person?: "owner" | "second"; readonly operatorKey?: string },
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
  const config = who.person === "second" ? join(dir, "second") : dir;
  const env: Record<string, string> = {
    SECBOT_CONFIG_DIR: config,
    SECBOT_CELL_URL: `http://${HOST}`,
  };
  if (who.operatorKey !== undefined) env.SECBOT_OPERATOR_KEY = who.operatorKey;
  const code = await run(argv, {
    environment: { env, home: config },
    io,
    fetch: workerFetch(setup),
  });
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

/** `October 2026` for the month of `at` in UTC (the cells' zone here). */
const monthTitle = (at: number) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(at);

/** One row of the designed layout, after its `HH:MM` time: agent, tool or job, verdict, layer. */
const rowBody = (agent: string, tool: string, verdict: string, layer: string) =>
  `  ${agent.padEnd(11)}${tool.padEnd(25)}${verdict.padEnd(14)}${layer.padEnd(10)}`;

/** The index of the row with this body whose reason line is `reason` (and cost, when given). */
function findRow(lines: readonly string[], body: string, reason: string, cost?: string): number {
  return lines.findIndex(
    (line, index) =>
      /^\d\d:\d\d$/.test(line.slice(0, 5)) &&
      line.slice(5, 67) === body &&
      /^ *\$\d+\.\d{4}$/.test(line.slice(67)) &&
      (cost === undefined || line.slice(67).trim() === cost) &&
      lines[index + 1] === `         ${reason}`,
  );
}

let requestNo = 0;
async function agentCall(setup: GuardSetup, line: string) {
  await setup.cells.get("owner")?.submitInput("owner", line, `activity-cli-${++requestNo}`);
}

const kinds = async (setup: GuardSetup) =>
  (await setup.harness("owner").activity({ limit: 200 })).records;

describe("secbot activity against the cell routes (AC-33)", () => {
  it("prints every kind with its verdict or state, layer, reason, and cost under the month's spend", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let releaseTrains: () => void = () => {};
    const trains = new Promise<void>((resolve) => {
      releaseTrains = resolve;
    });
    let releaseHealth: () => void = () => {};
    const health = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    releaseAll = () => {
      releaseTrains();
      releaseHealth();
    };
    const respond = async (request: FauxRequest) => {
      if (request.role === "research" && request.lastText.includes("trains")) await trains;
      if (request.role === "health") await health;
      if (request.role !== "lead") return fauxAssistantMessage([fauxText("found it")]);
      return scripted(request);
    };
    const setup = await openSetup({ respond });
    const owner = { person: "owner" as const };
    expect(
      (
        await secbot(
          setup,
          owner,
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
    expect(
      (await secbot(setup, owner, "rules", "add", "lead", "household_change", "ask-first")).code,
    ).toBe(0);
    const harness = setup.harness("owner");
    const count = async () => (await kinds(setup)).length;

    // Allowed, refused by a rule, and would block (shadow: the reviewer blocks, the call runs).
    await agentCall(setup, "CALL household_read {}");
    await until(async () => (await count()) === 1);
    await agentCall(setup, 'CALL search_history {"query":"bank"}');
    await until(async () => (await count()) === 2);
    stub.decision = riskyAt(0.9);
    await agentCall(setup, 'CALL set_reminder {"at":"09:00","text":"pay with card 4111"}');
    await until(async () => (await count()) === 3);
    stub.decision = routineAt(0.05);

    // A held call that lapses, then a held call answered allow once.
    await agentCall(setup, 'CALL household_change {"op":"add","text":"milk"}');
    await until(async () => (await kinds(setup)).some((record) => record.kind === "lapsed"));
    await agentCall(setup, 'CALL household_change {"op":"add","text":"eggs"}');
    await until(async () => (await harness.heldCalls()).length === 1);
    const [held] = await harness.heldCalls();
    await harness.answer(held?.number ?? 0, "allow", { device: "laptop" });
    await until(async () => (await kinds(setup)).some((record) => record.kind === "answered"));

    // A reminder that is delivered, and a hand-off that ends with a known cost.
    const at = new Date(Date.now() + 1_000).toISOString();
    await agentCall(setup, `CALL set_reminder {"at":"${at}","text":"bins out"}`);
    await until(async () =>
      (await kinds(setup)).some((record) => record.tool === "reminder: bins out"),
    );
    await agentCall(
      setup,
      'CALL handoff {"specialist":"research","brief":"trains to Leeds on Friday"}',
    );
    await until(() =>
      setup.gateway.requests.some(
        (request) => request.role === "research" && request.lastText.includes("trains"),
      ),
    );
    await addSpend(harness, 0.131, { role: "research" });
    releaseTrains();
    await until(async () =>
      (await kinds(setup)).some((record) => record.kind === "job" && record.agent === "research"),
    );

    // A running hand-off, then a waiting one above a lowered limit.
    await agentCall(setup, 'CALL handoff {"specialist":"health","brief":"sleep and caffeine"}');
    await until(() => setup.gateway.requests.some((request) => request.role === "health"));
    await harness.setLimit(0.01, "owner");
    await agentCall(setup, 'CALL handoff {"specialist":"research","brief":"buses to Leeds"}');
    await until(async () =>
      (await harness.activity()).live.some((row) => row.verdict === "waiting"),
    );

    const result = await secbot(setup, owner, "activity");
    await evidence("activity-all-kinds.txt", "activity", result);
    const cost = await secbot(setup, owner, "cost");
    await evidence("cost.txt", "cost", cost);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const lines = result.out.split("\n");
    const spent = /\[ month: (\$\d+\.\d\d) \/ /.exec(cost.out)?.[1];
    expect(spent).toBe("$0.13");
    expect(lines[0]).toBe(
      `${`ACTIVITY  owner  ${monthTitle(Date.now())}`.padEnd(78 - `[ total: ${spent} ]`.length)}[ total: ${spent} ]`,
    );
    expect(lines[1]).toBe(RULE);
    expect(lines[2]).toBe(
      "TIME   AGENT      TOOL OR JOB              VERDICT       LAYER       COST",
    );
    const expected: [string, string, string?][] = [
      [
        rowBody("lead", "household_read", "allowed", "decision"),
        "decision model: routine (score 0.05)",
      ],
      [
        rowBody("lead", "search_history", "refused", "rule"),
        "your rule: lead search_history (query = bank) -> prohibit",
      ],
      [
        rowBody("lead", "set_reminder", "would block", "reviewer"),
        "shadow: reminder text holds a card number; the call ran",
      ],
      [
        rowBody("lead", "household_change", "held", "rule"),
        "your rule: lead household_change (any) -> ask first",
      ],
      [rowBody("lead", "household_change", "lapsed", "person"), "no answer in 24 h; refused"],
      [rowBody("lead", "household_change", "allowed", "person"), "allowed once by owner"],
      [rowBody("lead", "reminder: bins out", "done", "job"), "delivered to the lead", "$0.0000"],
      [
        rowBody("research", "job: trains to Leeds on", "done", "job"),
        "answered the lead",
        "$0.1310",
      ],
      [
        rowBody("health", "job: sleep and caffeine", "running", "job"),
        "step 1 of 2: health is working",
      ],
    ];
    const missing = expected.filter(
      ([body, reason, money]) => findRow(lines, body, reason, money) === -1,
    );
    expect(missing).toEqual([]);
    const waiting = lines.findIndex(
      (line) => line.slice(5, 67) === rowBody("research", "job: buses to Leeds", "waiting", "job"),
    );
    expect(waiting).toBeGreaterThan(2);
    expect(lines[waiting + 1]).toMatch(/^ {9}waits above your limit since \d\d:\d\d$/);
    // Live jobs count in "showing N of M"; the footer names the month before.
    const view = await harness.activity();
    const rows = view.records.length + view.live.length;
    expect(lines.at(-2)).toMatch(
      new RegExp(
        `^showing ${rows} of ${view.total + view.live.length} this month; older: secbot activity --month \\d{4}-\\d\\d$`,
      ),
    );
    expect(fits(result.out)).toBe(true);
    expect(result.out).not.toContain("4111");
    await harness.harness.waitForIdle(BACKGROUND_CONTEXT).catch(() => {});
  }, 60_000);
});

describe("the empty state, old months, and paging", () => {
  it("prints the empty state for a fresh person cell", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const setup = await openSetup();
    const result = await secbot(setup, { person: "second" }, "activity");
    await evidence("activity-empty.txt", "activity", result);
    expect(result).toEqual({
      code: 0,
      out: [
        `${`ACTIVITY  second  ${monthTitle(Date.now())}`.padEnd(62)}[ total: $0.00 ]`,
        RULE,
        "no activity this month",
        "",
      ].join("\n"),
      err: "",
    });
  });

  it("lists records older than 90 days by month (AC-35) and pages a long month", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = Date.UTC(2026, 5, 10, 9, 0);
    const setup = await openSetup({ now: () => clock });
    const owner = { person: "owner" as const };
    await secbot(setup, owner, "rules", "add", "lead", "search_history", "prohibit");
    await agentCall(setup, 'CALL search_history {"query":"june"}');
    await until(async () => (await kinds(setup)).length === 1);

    clock = Date.UTC(2026, 9, 8, 12, 0);
    const now = await secbot(setup, owner, "activity");
    expect(now.out).toContain("\nno activity this month\n");
    const june = await secbot(setup, owner, "activity", "--month", "2026-06");
    await evidence("activity-month-2026-06.txt", "activity --month 2026-06", june);
    const juneLines = june.out.split("\n");
    expect(juneLines[0]).toMatch(/^ACTIVITY {2}owner {2}June 2026 +\[ total: \$0\.00 \]$/);
    expect(juneLines[3]).toBe(
      `09:00${rowBody("lead", "search_history", "refused", "rule")}$0.0000`,
    );
    expect(juneLines[4]).toBe("         your rule: lead search_history (any) -> prohibit");
    expect(juneLines[5]).toBe(
      "showing 1 of 1 in June 2026; older: secbot activity --month 2026-05",
    );

    // 120 records in September: 50 a page, newest first.
    const harness = setup.harness("owner");
    await harness.harness.commit(async (tx) => {
      for (let index = 0; index < 120; index++) {
        await appendRecord(
          tx,
          {
            key: `paging:${index}`,
            at: Date.UTC(2026, 8, 1, 6, 0) + index * 60_000,
            kind: "verdict",
            agent: "lead",
            tool: "search_history",
            verdict: "allowed",
            layer: "rule",
            reason: `call ${index}`,
            ruleId: null,
            ruleLevel: null,
            arguments: {},
            cost: 0,
          },
          "UTC",
        );
      }
    }, BACKGROUND_CONTEXT);
    const page1 = await secbot(setup, owner, "activity", "--month", "2026-09");
    const page2 = await secbot(setup, owner, "activity", "--month", "2026-09", "--page", "2");
    await evidence("activity-page-2.txt", "activity --month 2026-09 --page 2", page2);
    const page3 = await secbot(setup, owner, "activity", "--month", "2026-09", "--page", "3");
    const rowsOf = (out: string) => out.split("\n").filter((line) => /^\d\d:\d\d /.test(line));
    expect(rowsOf(page1.out)).toHaveLength(50);
    expect(page1.out).toContain("         call 119\n");
    expect(page1.out.split("\n").slice(-3, -1)).toEqual([
      "showing 50 of 120 in September 2026;",
      "  older: secbot activity --month 2026-09 --page 2",
    ]);
    expect(rowsOf(page2.out)).toHaveLength(50);
    expect(page2.out).toContain("         call 69\n");
    expect(rowsOf(page3.out)).toHaveLength(20);
    expect(page3.out).toContain("         call 0\n");
    expect(page3.out.split("\n").at(-2)).toBe(
      "showing 20 of 120 in September 2026; older: secbot activity --month 2026-08",
    );
    for (const result of [now, june, page1, page2, page3]) expect(fits(result.out)).toBe(true);
  }, 30_000);
});

describe("the person check and the owner's read (AC-34)", () => {
  it("refuses another person's device key, refuses a device key as the operator key, and shows the owner a person's activity", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const setup = await openSetup();
    const owner = { person: "owner" as const };
    await secbot(setup, owner, "rules", "add", "lead", "search_history", "prohibit");
    await agentCall(setup, 'CALL search_history {"query":"kale"}');
    await until(async () => (await kinds(setup)).length === 1);

    const fetchAs = (path: string) =>
      workerFetch(setup)(`http://${HOST}${path}`, {
        headers: { authorization: `Bearer ${SECOND_KEY}` },
      });
    for (const route of ["activity", "cost"]) {
      const response = await fetchAs(`/v1/cells/owner/${route}`);
      const body = (await response.json()) as unknown;
      await evidence(
        `${route}-device-refused.json`,
        `(GET /v1/cells/owner/${route} with second's device key)`,
        { code: response.status, out: `${JSON.stringify(body)}\n`, err: "" },
      );
      expect(response.status).toBe(403);
      expect(body).toEqual({ error: "refused: other_person" });
    }
    const refusals = loggedEvents(log.mock.calls).filter(
      (event) => event.event === "cli.refused" && event.reason === "other_person",
    );
    expect(refusals).toHaveLength(2);

    const asOperator = await secbot(
      setup,
      { person: "second", operatorKey: SECOND_KEY },
      "activity",
      "--person",
      "owner",
    );
    await evidence(
      "activity-device-refused.stderr.txt",
      "activity --person owner (second's device key as the operator key)",
      asOperator,
    );
    expect(asOperator).toEqual({
      code: 1,
      out: "",
      err: "secbot: the cell refused the operator key (refused: operator_key)\n",
    });

    const own = await secbot(setup, owner, "activity");
    const read = await secbot(
      setup,
      { person: "second", operatorKey: OPERATOR_KEY },
      "activity",
      "--person",
      "owner",
    );
    await evidence("activity-owner.txt", "activity --person owner (operator key)", read);
    expect(read.code).toBe(0);
    const [header, ...rest] = read.out.split("\n");
    expect(header).toBe(
      `${`ACTIVITY  owner (operator key)  ${monthTitle(Date.now())}`.padEnd(62)}[ total: $0.00 ]`,
    );
    const [, ...ownRest] = own.out.split("\n");
    // The same rows the person's own device sees; the footer names --person.
    expect(rest.slice(0, -2)).toEqual(ownRest.slice(0, -2));
    expect(rest.at(-2)).toMatch(
      /^showing 1 of 1 this month; older: secbot activity --person owner --month \d{4}-\d\d$/,
    );
    const everything = [asOperator, own, read].map((r) => r.out + r.err).join("");
    expect(everything).not.toContain(OPERATOR_KEY);
    expect(everything).not.toContain(SECOND_KEY);
    expect(everything).not.toContain(KEY);
  });
});
