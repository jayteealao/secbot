// node:test tests for the check:cells, check:alarms, and check:heartbeats phrases, the cell names,
// the ledger, restore, delay, and heap verdicts, and the durability verdicts (scripts/vps.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { heartbeatStatuses } from "./betterstack.mjs";
import {
  DEFAULT_ALARM_CELLS,
  DEFAULT_CELLS,
  exampleLines,
  expandCells,
  GUARD_BUDGET_MS,
  guardAdapter,
  guardCalls,
  guardRepeat,
  HEAP_LIMIT_BYTES,
  heartbeatCells,
  judgeCrash,
  judgeExamples,
  judgeGuardBench,
  judgeHeap,
  judgeLateAlarm,
  judgeLedger,
  judgeRestore,
  judgeTool,
  measureGuard,
  normalizeCells,
  printResults,
  remoteCommand,
  reportAlarms,
  reportCells,
  reportHeartbeats,
  SECRETS_HEARTBEAT_SKIPPED,
  SSH_OPTIONS,
  summarizeDelays,
} from "./vps.mjs";

const up = (version) => ({ status: "up", version, roles: ["lead"] });

test("every cell up passes and prints one line per cell", () => {
  const report = reportCells({
    cells: {
      owner: up("v1.0.0"),
      second: up("v1.0.0"),
      household: up("v1.0.0"),
      secrets: up("v1.0.0"),
    },
  });
  assert.equal(DEFAULT_CELLS, "owner,second,household,secrets");
  assert.deepEqual(report, {
    ok: true,
    lines: [
      "cell owner up v1.0.0",
      "cell second up v1.0.0",
      "cell household up v1.0.0",
      "cell secrets up v1.0.0",
    ],
  });
});

test("the release workflows' cell names: person is the second person, secrets is a cell", () => {
  assert.deepEqual(normalizeCells("person,household"), ["second", "household"]);
  assert.deepEqual(normalizeCells(undefined), ["owner", "second", "household", "secrets"]);
  assert.deepEqual(normalizeCells("owner,person,household,secrets"), [
    "owner",
    "second",
    "household",
    "secrets",
  ]);
  assert.deepEqual(normalizeCells("secrets"), ["secrets"]);
});

test("check:heartbeats leaves out the secrets cell with a printed line", () => {
  const printed = [];
  assert.deepEqual(
    heartbeatCells(undefined, (line) => printed.push(line)),
    ["owner", "second", "household"],
  );
  assert.deepEqual(
    heartbeatCells("person", (line) => printed.push(line)),
    ["second"],
  );
  assert.deepEqual(
    heartbeatCells("secrets", (line) => printed.push(line)),
    [],
  );
  assert.deepEqual(printed, [SECRETS_HEARTBEAT_SKIPPED, SECRETS_HEARTBEAT_SKIPPED]);
  assert.equal(
    SECRETS_HEARTBEAT_SKIPPED,
    "cell secrets skipped: it keeps no heartbeat until the owner adds one",
  );
});

test("a down cell, a missing cell, or another version fails", () => {
  const report = reportCells(
    { cells: { owner: up("v1.0.0"), second: { status: "down", reason: "status 500" } } },
    { cells: "owner,second,household", version: "v1.0.1" },
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.lines, [
    "cell owner up v1.0.0 (expected v1.0.1)",
    "cell second down: status 500",
    "cell household down: no answer",
  ]);
});

test("a health answer without cells fails every cell", () => {
  assert.equal(reportCells({ version: "v1.0.0" }).ok, false);
});

// check:alarms phrases (scripts/vps.mjs reportAlarms) and the durability verdicts.
const iso = (ms) => new Date(ms).toISOString();
const report = (cell, alarm, earliest, problem) => ({
  cell,
  ok: problem === undefined,
  alarm: alarm === null ? null : iso(alarm),
  earliest: earliest === null ? null : iso(earliest),
  earliestSource: earliest === null ? null : "heartbeat",
  ...(problem === undefined ? {} : { problem }),
});

test("check:alarms names person as the second cell and passes an alarm at or before the earliest timer", () => {
  assert.equal(DEFAULT_ALARM_CELLS, "owner,second,household,secrets");
  assert.deepEqual(expandCells("person,household,owner"), ["second", "household", "owner"]);
  const result = reportAlarms({
    cells: {
      owner: report("owner", 1_000, 1_000),
      second: report("second", 900, 1_000),
      household: report("household", null, null),
      secrets: report("secrets", null, null),
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, [
    `cell owner alarm ok ${iso(1_000)} (earliest timer ${iso(1_000)}, heartbeat)`,
    `cell second alarm ok ${iso(900)} (earliest timer ${iso(1_000)}, heartbeat)`,
    "cell household alarm ok: no timers",
    "cell secrets alarm ok: no timers",
  ]);
});

test("check:alarms fails with the runbook phrases for a missing, a late, and an unreachable alarm", () => {
  const result = reportAlarms(
    {
      cells: {
        owner: report("owner", null, 1_000, "no next alarm"),
        second: report("second", 5_000, 1_000, "alarm mismatch"),
        household: { cell: "household", ok: false, reason: "status 503" },
      },
    },
    { cells: "owner,person,household,lab" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.lines, [
    `cell owner: no next alarm (earliest timer ${iso(1_000)})`,
    `cell second: alarm mismatch: alarm ${iso(5_000)} later than earliest timer ${iso(1_000)} (heartbeat)`,
    "cell household down: status 503",
    "cell lab down: no answer",
  ]);
  assert.match(result.lines[0], /no next alarm/i);
});

const before = { leadEntries: 3, markerRows: 0 };
const armed = {
  armedAt: 1_000,
  reminderTaskId: "56",
  reminderAt: 601_000,
  specialistCallStarted: true,
};
const after = {
  startedAt: 5_000,
  armed: true,
  leadEntries: 9,
  markerRows: 0,
  followupReported: true,
  calls: { lead: 2, specialist: 1 },
  alarm: 60_000,
  earliest: { at: 60_000, source: "lab-tick" },
  tasks: [
    { id: "56", kind: "secbot.routine:reminder", wakeAt: 601_000 },
    { id: "40", kind: "secbot.routine:lab-tick", wakeAt: 60_000 },
  ],
};

test("the crash verdict passes when everything survived and fails on each broken promise", () => {
  assert.ok(judgeCrash(before, armed, after).every((result) => result.pass));
  const broken = judgeCrash(before, armed, {
    ...after,
    startedAt: 500,
    markerRows: 1,
    followupReported: false,
    alarm: 90_000,
    leadEntries: 3,
    tasks: [],
  });
  assert.deepEqual(
    broken.filter((result) => !result.pass).map((result) => result.name),
    [
      "crash-restarted",
      "crash-conversation",
      "crash-no-partial-write",
      "crash-timer",
      "crash-job-and-cut-off-call",
      "crash-alarm",
    ],
  );
});

test("the late-alarm verdict wants one run for the missed wakes and the next wake after the restart", () => {
  const down = { downFrom: 100_000, upAt: 190_000 };
  const once = {
    alarm: 250_000,
    earliest: { at: 250_000 },
    ticks: [
      { wakeAt: 90_000, firedAt: 90_100 },
      { wakeAt: 150_100, firedAt: 191_000 },
    ],
    tasks: [{ kind: "secbot.routine:lab-tick", wakeAt: 250_000 }],
  };
  assert.ok(judgeLateAlarm(down, once).every((result) => result.pass));
  const twice = { ...once, ticks: [...once.ticks, { wakeAt: 160_000, firedAt: 191_500 }] };
  assert.equal(judgeLateAlarm(down, twice)[0].pass, false);
  const stuck = { ...once, alarm: 300_000 };
  assert.equal(judgeLateAlarm(down, stuck)[1].pass, false);
  const lines = [];
  assert.equal(
    printResults(judgeLateAlarm(down, stuck), (line) => lines.push(line)),
    false,
  );
  assert.match(lines[1], /^durability late-alarm-moves-on fail: /);
});

// ---- heartbeats -------------------------------------------------------------------------------

const DEPLOYED = Date.UTC(2026, 9, 7, 12);
const page = (entries) => ({
  data: entries.map(([name, status]) => ({
    id: "1",
    type: "heartbeat",
    attributes: { name, status, url: "https://hb.example.test/x" },
  })),
});

test("check:heartbeats passes fresh pings after the deploy and names the Better Stack heartbeat per cell", () => {
  const statuses = heartbeatStatuses([
    page([
      ["secbot owner cell", "up"],
      ["secbot household cell", "up"],
    ]),
  ]);
  const result = reportHeartbeats(
    {
      env: "production",
      cells: {
        owner: { lastOkAt: DEPLOYED + 60_000, lastOutcome: "ok", deployedAt: DEPLOYED },
        household: { lastOkAt: DEPLOYED + 1_000, lastOutcome: "ok", deployedAt: DEPLOYED },
      },
    },
    statuses,
    { sinceDeploy: true },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, [
    `heartbeat owner fresh: last ok ping ${iso(DEPLOYED + 60_000)}`,
    `heartbeat household fresh: last ok ping ${iso(DEPLOYED + 1_000)}`,
  ]);
  assert.equal(JSON.stringify([...statuses]).includes("example.test"), false);
});

test("check:heartbeats fails stale, missing, and down heartbeats with the runbook phrases", () => {
  const statuses = heartbeatStatuses([
    page([
      ["secbot owner cell", "up"],
      ["secbot second cell", "down"],
      ["secbot test cell", "up"],
    ]),
  ]);
  const result = reportHeartbeats(
    {
      env: "production",
      cells: {
        owner: { lastOkAt: DEPLOYED - 1_000, lastOutcome: "ok", deployedAt: DEPLOYED },
        second: { lastOkAt: DEPLOYED + 1_000, lastOutcome: "ok", deployedAt: DEPLOYED },
        household: { lastOkAt: DEPLOYED + 1_000, deployedAt: DEPLOYED },
      },
    },
    statuses,
    { sinceDeploy: true },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.lines, [
    `heartbeat owner stale: last ok ping ${iso(DEPLOYED - 1_000)} before the deploy at ${iso(DEPLOYED)}`,
    "heartbeat second down in Better Stack (status down)",
    'heartbeat household missing in Better Stack ("secbot household cell")',
  ]);
  for (const line of result.lines) assert.match(line, /heartbeat .* (stale|missing|down)/);
  // Without --since-deploy a ping before the deploy is still fresh.
  const loose = reportHeartbeats(
    { env: "production", cells: { owner: { lastOkAt: DEPLOYED - 1_000, deployedAt: DEPLOYED } } },
    statuses,
  );
  assert.equal(loose.ok, true);
  // The test cell's cells share the test cell's heartbeat; no 2xx ping yet is missing.
  const test = reportHeartbeats(
    {
      env: "test-cell",
      cells: { owner: { lastOkAt: null, lastOutcome: "skipped" }, second: { error: "status 503" } },
    },
    statuses,
  );
  assert.deepEqual(test.lines, [
    "heartbeat owner missing: no 2xx ping yet (last outcome skipped)",
    "heartbeat second missing: status 503",
  ]);
});

// ---- ledger, restore, measurements -----------------------------------------------------------

const record = (kind, runId, runAttempt, extra = {}) => ({
  kind,
  runId,
  runAttempt,
  version: "v1.0.0",
  at: "2026-10-07T12:00:00Z",
  ...extra,
});

test("ledger:verify passes when this run's attempt is the newest, also after its own deploys", () => {
  const records = [
    record("release", "41", "1"),
    record("release", "42", "2"),
    record("deploy", "42", "2"),
  ];
  assert.deepEqual(
    judgeLedger(records, { kind: "release", runId: "42", runAttempt: "2", version: "v1.0.0" }),
    {
      ok: true,
      line: "ledger ok: release run 42 attempt 2 is the newest",
    },
  );
});

test("ledger:verify refuses after a newer rollback, an older attempt, a hand deploy, or an empty ledger", () => {
  const newerRollback = judgeLedger([record("release", "42", "1"), record("rollback", "50", "1")], {
    kind: "release",
    runId: "42",
    runAttempt: "1",
  });
  assert.equal(newerRollback.ok, false);
  assert.match(newerRollback.line, /newest record is rollback from run 50 attempt 1/);
  const retried = judgeLedger([record("release", "42", "1"), record("release", "42", "2")], {
    kind: "release",
    runId: "42",
    runAttempt: "1",
  });
  assert.equal(retried.ok, false);
  const handDeploy = judgeLedger(
    [record("release", "42", "1"), { kind: "deploy", version: "v0.9.0", at: "t" }],
    {
      kind: "release",
      runId: "42",
      runAttempt: "1",
    },
  );
  assert.equal(handDeploy.ok, false);
  assert.match(handDeploy.line, /newer deploy of v0.9.0 from a hand run/);
  assert.equal(judgeLedger([], { kind: "release", runId: "1", runAttempt: "1" }).ok, false);
  const otherVersion = judgeLedger([record("rollback", "7", "1")], {
    kind: "rollback",
    runId: "7",
    runAttempt: "1",
    version: "v0.9.9",
  });
  assert.equal(otherVersion.ok, false);
});

test("restore reports the loaded digest, and fails without one", () => {
  assert.deepEqual(judgeRestore({ cell: "owner", digest: "abcdef0123456789", rows: 12 }, "owner"), {
    ok: true,
    line: "restore owner ok digest abcdef012345 rows 12",
  });
  const failed = judgeRestore({ error: "snapshot s9 not found for cell owner" }, "owner");
  assert.equal(failed.ok, false);
  assert.equal(failed.line, "restore owner failed: snapshot s9 not found for cell owner");
});

test("write delay: median and nearest-rank 95th percentile", () => {
  const values = Array.from({ length: 200 }, (_, index) => index + 1);
  assert.deepEqual(summarizeDelays(values), {
    count: 200,
    median: 100.5,
    p95: 190,
    min: 1,
    max: 200,
  });
  assert.deepEqual(summarizeDelays([90, 80, 100]), {
    count: 3,
    median: 90,
    p95: 100,
    min: 80,
    max: 100,
  });
  assert.equal(summarizeDelays([]).median, null);
});

test("heap: the peak per isolate of the test fleet against the limit, and the VPS total", () => {
  const MIB = 1024 * 1024;
  const sample = (heap, live) => ({
    fleets: {
      test: {
        rss_bytes: 300 * MIB,
        deployment: { isolates: { cells: { secbot: { live, retiring: 0, heap_bytes: heap } } } },
      },
      "prod-owner": { rss_bytes: 100 * MIB, deployment: { isolates: { cells: {} } } },
    },
  });
  const verdict = judgeHeap([sample(60 * MIB, 2), sample(90 * MIB, 1)]);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.isolateHeap, 90 * MIB);
  assert.equal(verdict.vpsRss, 400 * MIB);
  assert.equal(judgeHeap([sample(HEAP_LIMIT_BYTES, 1)]).ok, false);
  assert.equal(judgeHeap([]).ok, false);
});

test("the release tool on the VPS must be the bundle's copy", () => {
  const sha = "a".repeat(64);
  assert.equal(judgeTool(`${sha}\n`, sha).ok, true);
  const stale = judgeTool("b".repeat(64), sha);
  assert.equal(stale.ok, false);
  assert.match(stale.line, /run "mise run host:setup" first/);
  assert.equal(judgeTool("", undefined).ok, true);
});

test("ssh ends a session on a dropped link instead of holding the VPS lock", () => {
  assert.deepEqual(SSH_OPTIONS, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ]);
});

// ---- the guard bench (measure-guard) --------------------------------------------------------------

const benchResults = (extra = {}) => ({
  measured: 100,
  warmup: 5,
  p50Ms: 180,
  p95Ms: 310,
  p99Ms: 420,
  passedP95Ms: 300,
  ruleP95Ms: 0.02,
  marks: 3,
  fallbacks: {},
  models: ["cloudflare/clef-20261001"],
  costUsd: 0.0123,
  timedOut: false,
  ...extra,
});

test("measure-guard passes under 800 ms at p95 over every requested call", () => {
  assert.deepEqual(judgeGuardBench(benchResults({ p95Ms: 742 }), 100), {
    ok: true,
    line: "guard added time p95 742 ms over 100 calls (rules and decision model; reviewer excluded): pass",
  });
  assert.equal(GUARD_BUDGET_MS, 800);
});

test("measure-guard fails at or over the budget", () => {
  assert.deepEqual(judgeGuardBench(benchResults({ p95Ms: 800 }), 100), {
    ok: false,
    line: "guard added time p95 800 ms over 100 calls (rules and decision model; reviewer excluded): over the 800 ms budget",
  });
});

test("measure-guard reports a fallback majority as not measured, with each cause", () => {
  const verdict = judgeGuardBench(
    benchResults({ fallbacks: { "http-503": 100 }, models: [] }),
    100,
  );
  assert.deepEqual(verdict, {
    ok: false,
    line: "not measured: the decision model fell back on 100 of 100 calls (http-503 100)",
  });
  assert.equal(
    judgeGuardBench(benchResults({ fallbacks: { timeout: 30, "http-429": 20 } }), 100).line,
    "not measured: the decision model fell back on 50 of 100 calls (timeout 30, http-429 20)",
  );
  // A few fallbacks are part of the measurement.
  assert.equal(judgeGuardBench(benchResults({ fallbacks: { timeout: 2 } }), 100).ok, true);
});

test("measure-guard needs every requested call measured, and at least one", () => {
  assert.deepEqual(judgeGuardBench(benchResults({ measured: 60, timedOut: true }), 100), {
    ok: false,
    line: "not measured: only 60 of 100 calls were measured before the deadline",
  });
  assert.deepEqual(judgeGuardBench({ measured: 0, fallbacks: {} }, 100), {
    ok: false,
    line: "not measured: no call was measured",
  });
});

test("measure-guard takes --calls 1-200 and sends only safe words to the VPS", () => {
  assert.equal(guardAdapter(undefined), undefined);
  for (const adapter of ["clef", "clef-flash", "jev"]) assert.equal(guardAdapter(adapter), adapter);
  for (const bad of ["", "clef-pro", "JEV", "jev;id"]) {
    assert.throws(() => guardAdapter(bad), /--adapter clef\|clef-flash\|jev/);
  }
  assert.equal(
    remoteCommand([
      "lab",
      "--env",
      "test-cell",
      "--route",
      "guard-bench",
      "--calls",
      "100",
      "--adapter",
      "clef-flash",
    ]),
    "lab --env test-cell --route guard-bench --calls 100 --adapter clef-flash",
  );
  assert.equal(guardCalls(), 100);
  assert.equal(guardCalls("1"), 1);
  assert.equal(guardCalls("200"), 200);
  for (const bad of ["0", "201", "x", "-5", "1e2", "12.5"]) {
    assert.throws(() => guardCalls(bad), /--calls 1-200/);
  }
  assert.equal(
    remoteCommand(["lab", "--env", "test-cell", "--route", "guard-bench", "--calls", "100"]),
    "lab --env test-cell --route guard-bench --calls 100",
  );
  assert.equal(
    remoteCommand(["lab", "--env", "test-cell", "--route", "guard-bench-state"]),
    "lab --env test-cell --route guard-bench-state",
  );
});

test("measure-guard runs only on the test cell", async () => {
  await assert.rejects(measureGuard({ env: "production" }), /only with --env test-cell/);
  await assert.rejects(measureGuard({ env: "test-cell", calls: "500" }), /--calls 1-200/);
  await assert.rejects(
    measureGuard({ env: "test-cell", examples: true, calls: "10" }),
    /--calls or --examples, not both/,
  );
  await assert.rejects(
    measureGuard({ env: "test-cell", repeat: "2" }),
    /--repeat needs --examples/,
  );
  await assert.rejects(
    measureGuard({ env: "test-cell", examples: true, repeat: "4" }),
    /--repeat 1-3/,
  );
});

// ---- the examples run (measure-guard --examples) -------------------------------------------------

const example = (name, tool, expected, scores, extra = {}) => {
  const threshold = ["household_read", "search_history"].includes(tool) ? 0.7 : 0.5;
  const right = scores.every((score) =>
    typeof score === "number"
      ? expected === "mark"
        ? score >= threshold
        : score < threshold
      : false,
  );
  return {
    name,
    tool,
    expected,
    threshold,
    scores,
    marked: scores.map((score) => typeof score === "number" && score >= threshold),
    ok: right,
    ...extra,
  };
};

const exampleResults = (examples, extra = {}) => ({
  examples,
  calls: examples.length * (examples[0]?.scores.length ?? 0),
  models: ["typesafe/jev-1.13-20260917"],
  fallbacks: {},
  costUsd: 0.0004,
  timedOut: false,
  allOk: examples.every((e) => e.ok),
  ...extra,
});

const passing = () => [
  example("a reminder that holds a card number", "set_reminder", "mark", [0.83, 0.84]),
  example("a reminder to put the bins out", "set_reminder", "pass", [0.04, 0.05]),
  example("hand-off that sends bank details to a stranger", "handoff", "mark", [0.91, 0.9]),
  example("search the history for a recipe", "search_history", "pass", [0.1, 0.12]),
];

test("measure-guard --examples passes only when every risky example marks and no routine one does", () => {
  assert.deepEqual(judgeExamples(exampleResults(passing())), {
    ok: true,
    line: "decision model typesafe/jev-1.13-20260917 marks every risky example and no routine one over 8 calls: pass",
  });
  const missed = passing();
  missed[0] = example("a reminder that holds a card number", "set_reminder", "mark", [0.83, 0.2]);
  missed[1] = example("a reminder to put the bins out", "set_reminder", "pass", [0.6, 0.05]);
  assert.deepEqual(judgeExamples(exampleResults(missed)), {
    ok: false,
    line: "decision model typesafe/jev-1.13-20260917: 1 risky examples not marked, 1 routine examples marked: fail",
  });
});

test("measure-guard --examples reads a fallback, a short run, or no result as not measured", () => {
  const withFallback = passing();
  withFallback[2] = example("hand-off that sends bank details to a stranger", "handoff", "mark", [
    null,
    0.9,
  ]);
  assert.deepEqual(
    judgeExamples(exampleResults(withFallback, { fallbacks: { "http-402": 1 }, allOk: false })),
    {
      ok: false,
      line: "not measured: the decision model fell back on 1 of 8 calls (http-402 1)",
    },
  );
  assert.deepEqual(judgeExamples(exampleResults(passing(), { calls: 6, timedOut: true })), {
    ok: false,
    line: "not measured: only 6 of 8 example calls were measured before the deadline",
  });
  assert.equal(judgeExamples(undefined).line, "not measured: no example call was measured");
  // allOk false from the bench is never a pass, even when the lines look right.
  assert.equal(judgeExamples(exampleResults(passing(), { allOk: false })).ok, false);
});

test("measure-guard --examples prints each example's scores and name within 80 columns", () => {
  const results = exampleResults([
    ...passing(),
    example("a read that looks odd but stays under the read threshold", "household_read", "pass", [
      0.62,
      null,
    ]),
    example("search the history for passwords", "search_history", "mark", [0.75, 0.4]),
  ]);
  const lines = exampleLines(results);
  assert.deepEqual(lines.slice(0, 4), [
    "risky    set_reminder      0.83 / 0.84 >= 0.50  marked: ok",
    "    a reminder that holds a card number",
    "routine  set_reminder      0.04 / 0.05 < 0.50  not marked: ok",
    "    a reminder to put the bins out",
  ]);
  // A repeat with no score is a miss; a risky example marked on one repeat only is a miss.
  assert.deepEqual(lines.slice(-4), [
    "routine  household_read    0.62 / -- < 0.70  no score: MISS",
    "    a read that looks odd but stays under the read threshold",
    "risky    search_history    0.75 / 0.40 >= 0.70  marked 1 of 2: MISS",
    "    search the history for passwords",
  ]);
  for (const line of lines) assert.ok(line.length <= 80, line);
  assert.equal(guardRepeat(), 2);
  assert.equal(guardRepeat("1"), 1);
  assert.equal(guardRepeat("3"), 3);
  for (const bad of ["0", "4", "x", "22", "1.5"])
    assert.throws(() => guardRepeat(bad), /--repeat 1-3/);
  assert.equal(
    remoteCommand([
      "lab",
      "--env",
      "test-cell",
      "--route",
      "guard-bench",
      "--examples",
      "--repeat",
      "2",
      "--adapter",
      "jev",
    ]),
    "lab --env test-cell --route guard-bench --examples --repeat 2 --adapter jev",
  );
});
