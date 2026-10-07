// node:test tests for the check:cells and check:alarms phrases and the durability verdicts
// (scripts/vps.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ALARM_CELLS,
  DEFAULT_CELLS,
  expandCells,
  judgeCrash,
  judgeLateAlarm,
  printResults,
  reportAlarms,
  reportCells,
} from "./vps.mjs";

const up = (version) => ({ status: "up", version, roles: ["lead"] });

test("every person cell up passes and prints one line per cell", () => {
  const report = reportCells({ cells: { owner: up("v1.0.0"), second: up("v1.0.0") } });
  assert.equal(DEFAULT_CELLS, "owner,second");
  assert.deepEqual(report, { ok: true, lines: ["cell owner up v1.0.0", "cell second up v1.0.0"] });
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

test("check:alarms expands person and passes an alarm at or before the earliest timer", () => {
  assert.equal(DEFAULT_ALARM_CELLS, "person,household");
  assert.deepEqual(expandCells("person,household,owner"), ["owner", "second", "household"]);
  const result = reportAlarms({
    cells: {
      owner: report("owner", 1_000, 1_000),
      second: report("second", 900, 1_000),
      household: report("household", null, null),
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, [
    `cell owner alarm ok ${iso(1_000)} (earliest timer ${iso(1_000)}, heartbeat)`,
    `cell second alarm ok ${iso(900)} (earliest timer ${iso(1_000)}, heartbeat)`,
    "cell household alarm ok: no timers",
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
    { cells: "person,household,lab" },
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
