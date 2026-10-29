// The live jobs check's pure parts: preflight on a temporary home, with and without the second
// person's device; the contract patterns against their approved lines; the steps; the kept job
// numbers; the scrubber; and the report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PREFLIGHT_PAD } from "./live-guard.mjs";
import { literalHits, scrub } from "./live-guard-steps.mjs";
import {
  argumentProblem,
  LIVE_CELLS,
  LIVE_SIGNALS,
  measuredBack,
  preflight,
  privateValues,
  report,
  signalLines,
} from "./live-jobs.mjs";
import {
  ALL_CHECKS,
  buildReport,
  CONTRACT,
  DEFAULT_MAX_USD,
  keptNumber,
  STEPS,
  stepsOf,
} from "./live-jobs-steps.mjs";

const KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef"; // gitleaks:allow (fake test key)
const SECOND_KEY = "second-laptop-key-89abcdef0123456789abcdef01234567"; // gitleaks:allow (fake test key)
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** A temporary home with the owner's device and, optionally, the second person's. */
async function home({ second }) {
  const dir = await mkdtemp(join(tmpdir(), "live-jobs-pre-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  const secondDir = join(dir, "second");
  await mkdir(secondDir);
  if (second !== undefined) {
    await writeFile(
      join(secondDir, "device.json"),
      JSON.stringify({ name: "laptop2", person: second, key: SECOND_KEY }),
    );
  }
  const env = {
    SECBOT_CONFIG_DIR: dir,
    SECBOT_SECOND_CONFIG_DIR: secondDir,
    SECBOT_CELL_URL: "https://cell.example.test",
    SECBOT_VPS_SSH: "alias-x",
    OPENROUTER_API_KEY: "sk-or-test-not-a-real-key-000", // gitleaks:allow (fake test key)
    BETTERSTACK_INCIDENTS_TOKEN: "bs-test-token",
    BETTERSTACK_REQUESTER_EMAIL: "owner@example.com",
    SECBOT_DEVICE_KEYS: `laptop:owner:${sha(KEY)},laptop2:second:${sha(SECOND_KEY)}`,
    SECBOT_TIME_ZONE: "Europe/London",
    SECBOT_OPERATOR_KEY: "operator-test-key-0000",
  };
  return { dir, env };
}

test("preflight is ready with the second person's device and never prints a value", async () => {
  const { dir, env } = await home({ second: "second" });
  try {
    const ready = await preflight(env, dir);
    assert.equal(ready.ok, true, ready.lines.join("\n"));
    assert.equal(ready.lines.at(-1), "preflight: ready");
    assert.ok(ready.lines.includes(`${"SECBOT_SECOND_CONFIG_DIR".padEnd(PREFLIGHT_PAD)}SET`));
    assert.ok(ready.lines.includes(`${"second device key listed".padEnd(PREFLIGHT_PAD)}yes`));
    const text = ready.lines.join("\n");
    for (const value of [...Object.values(env), KEY, SECOND_KEY]) {
      if (!value.startsWith(dir)) assert.ok(!text.includes(value), "a value was printed");
    }
    assert.ok(ready.lines.every((line) => line.length <= 80 || line.startsWith("SECBOT_FAKE")));
    const { values } = await privateValues(env, dir);
    assert.equal(values["second-device-key"], SECOND_KEY);
    assert.equal(values["device-key"], KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preflight is not ready without the second device, with another person's, or unlisted", async () => {
  for (const [second, keys] of [
    [undefined, undefined],
    ["owner", undefined],
    ["second", `laptop:owner:${sha(KEY)}`],
  ]) {
    const { dir, env } = await home({ second });
    try {
      const ready = await preflight(
        keys === undefined ? env : { ...env, SECBOT_DEVICE_KEYS: keys },
        dir,
      );
      assert.equal(ready.ok, false, String(second));
      assert.equal(ready.lines.at(-1), "preflight: not ready; place what is missing first");
      if (keys === undefined) {
        assert.ok(
          ready.lines.includes(`${"SECBOT_SECOND_CONFIG_DIR".padEnd(PREFLIGHT_PAD)}missing`),
        );
      } else {
        assert.ok(ready.lines.includes(`${"second device key listed".padEnd(PREFLIGHT_PAD)}no`));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const { dir, env } = await home({ second: "second" });
  try {
    const noOperator = await preflight({ ...env, SECBOT_OPERATOR_KEY: "" }, dir);
    assert.equal(noOperator.ok, false);
    assert.ok(noOperator.lines.includes(`${"operator key".padEnd(PREFLIGHT_PAD)}missing`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The approved lines, as the command line prints them, and a near miss of each.
const APPROVED = {
  usage: ["[ month: $0.42 / $25.00 ] [#.........] 1%", "[ month: $0.42 / $25 ] [#.........] 1%"],
  boardHeader: [
    "JOBS  owner  [ live: 2 ] [ results waiting: 1 ]  [ shadow ]",
    "JOBS owner [ live: 2 ] [ results waiting: 1 ] [ shadow ]",
  ],
  waitingOne: ["[ results waiting: 1 ]", "[ results waiting: 10 ]"],
  waitingNone: ["[ results waiting: 0 ]", "[ results waiting: 01 ]"],
  running: [
    "3   train options          research  mid/medium  1/3   $0.02/$1    running",
    "3   train options          research  mid/medium  1/3   $0.02/$1    running late",
  ],
  paused: [
    "4   lisbon lookup          research  mid/medium  1/3   $0.01/$1    paused",
    "4   lisbon lookup          research  mid/medium  1/3   $0.01/$1    pausedx",
  ],
  loopReason: [
    "      same step failed 3 times; the lead decides what next",
    "    same step failed 3 times; the lead decides what next",
  ],
  asks: ["[ job 4 asks ] answer with /answer 4 <text>", "[ job 4 asks ] answer with /reply 4"],
  failed: [
    "4   lisbon lookup          research  mid/medium  3/3   $0.03/$1    failed",
    "4   lisbon lookup          research  mid/medium  3/3   $0.03/$1    fail",
  ],
  exhausted: ["      raise and restart used; the lead asked you", "      raise and restart used"],
  blocked: [
    "5   gym prices             research  mid/medium  1/3   $0.01/$1    blocked",
    "5   gym prices             research  mid/medium  1/3   $0.01/$1    block",
  ],
  pageReason: [
    "      a page tried to give the agent orders; nothing from it was used",
    "      an email tried to give the agent orders; nothing from it was used",
  ],
  stopped: [
    "[ stopped ] 2 jobs and the lead's current turn. Their state is kept.",
    "[ stopped ] 2 jobs. State kept.",
  ],
  stoppedRow: [
    "6   slow one               research  mid/medium  1/3   $0.01/$1    stopped",
    "6   slow one               research  mid/medium  1/3   $0.01/$1    stopping",
  ],
  stoppedByYou: [
    "      stopped by you at 14:05; secbot jobs restart 6",
    "      stopped by the owner at 14:05; secbot jobs restart 6",
  ],
  stoppedByOwner: [
    "      stopped by the owner at 14:05; secbot jobs restart 8",
    "      stopped by you at 14:05; secbot jobs restart 8",
  ],
  restarted: [
    "[ restarted ] #6 slow one, from its kept brief and transcript",
    "[ restarted ] #6 slow one is paused, not stopped; ask the lead",
  ],
  stopAll: [
    "[ stopped ] household: 3 jobs and 2 lead turns. Their state is kept.",
    "[ stopped ] household: 3 jobs. Their state is kept.",
  ],
  stopAllOwner: ["  owner     1 job, lead turn", "  owner     0 jobs"],
  stopAllSecond: ["  second    1 job", "  second  1 job"],
  stopAllHousehold: ["  household 1 shared job", "  household 1 job"],
  sharedOffer: [
    "[ job 2 shared ] /join 2 to share the cost, /decline 2 to leave it to owner",
    "[ job 2 shared ] /join 2 to see it",
  ],
  joined: [
    "[ joined ] #2 weekend plan; you pay half",
    "[ declined ] #2 weekend plan; owner's lead was told",
  ],
  capacity: [
    "[ 2 jobs at once; this cell was measured at 1 on 29 Oct ] nothing is held back",
    "[ 2 jobs at once; this cell was measured at 1 on 2026-10-29 ] nothing is held back",
  ],
};

test("every contract pattern matches its approved line and refuses a near miss", () => {
  assert.deepEqual(
    Object.keys(APPROVED).sort(),
    Object.keys(CONTRACT)
      .filter((name) => name !== "twoRunning")
      .sort(),
  );
  for (const [name, [approved, near]] of Object.entries(APPROVED)) {
    assert.match(approved, CONTRACT[name], name);
    assert.doesNotMatch(near, CONTRACT[name], `${name} took a near miss`);
  }
  const two = `${APPROVED.running[0]}\n${APPROVED.running[0].replace(/^3/, "4")}`;
  assert.match(two, CONTRACT.twoRunning);
  assert.doesNotMatch(APPROVED.running[0], CONTRACT.twoRunning);
});

test("every step has an id, evidence, criteria, and patterns, and the stop expects all three cells", () => {
  assert.deepEqual(
    STEPS.map((step) => step.id),
    ["c1", "c2", "c3", "c4", "c5", "c6", "s7", "k1"],
  );
  for (const step of STEPS) {
    assert.match(step.evidence, /^[a-z0-9-]+\.txt$/, step.id);
    assert.ok(step.checks.length > 0, step.id);
    assert.ok(step.actions.length > 0, step.id);
    for (const action of step.actions) {
      if (["cmd", "chat", "watch", "open"].includes(action.kind)) {
        assert.ok((action.expect ?? []).length > 0, `${step.id} ${action.kind} expects nothing`);
      }
    }
  }
  assert.deepEqual(
    STEPS.filter((step) => step.id.startsWith("c")).map((step) => step.evidence),
    [1, 2, 3, 4, 5, 6].map((n) => `charter-${n}.txt`),
  );
  const s7 = STEPS.find((step) => step.id === "s7");
  const stopAll = s7.actions.find((action) => action.argv?.join(" ") === "stop --all");
  assert.equal(stopAll.as, "operator");
  for (const cell of [CONTRACT.stopAllOwner, CONTRACT.stopAllSecond, CONTRACT.stopAllHousehold]) {
    assert.ok(stopAll.expect.includes(cell));
  }
  assert.ok(
    s7.actions.some((action) => action.as === "second" && action.say === "/join {job:shared}"),
  );
  assert.deepEqual(
    stepsOf("charter").map((step) => step.id),
    ["c1", "c2", "c3", "c4", "c5", "c6"],
  );
  assert.deepEqual(
    stepsOf("stop-all").map((step) => step.id),
    ["s7"],
  );
  assert.deepEqual(
    stepsOf("capacity-line").map((step) => step.id),
    ["k1"],
  );
  assert.equal(DEFAULT_MAX_USD, 10);
  assert.ok(ALL_CHECKS.includes("capacity-line"));
});

test("a kept job number is the newest match's first group", () => {
  const board = `${APPROVED.stoppedByYou[0]}\n${APPROVED.stoppedByYou[0].replace(/6$/, "7")}`;
  assert.equal(keptNumber(board, CONTRACT.stoppedByYou), 7);
  assert.equal(keptNumber(APPROVED.sharedOffer[0], CONTRACT.sharedOffer), 2);
  assert.equal(keptNumber("nothing here", CONTRACT.running), undefined);
});

test("scrub and the literal search remove a planted private value from a transcript", () => {
  const values = { "second-device-key": SECOND_KEY, "cell-url": "https://cell.example.test" };
  const transcript = `(as second) $ secbot jobs\nkey ${SECOND_KEY} at https://cell.example.test/v1\n`;
  assert.deepEqual(literalHits(transcript, values).sort(), [
    "cell-url",
    "cell-url-host",
    "second-device-key",
  ]);
  const clean = scrub(transcript, values);
  assert.deepEqual(literalHits(clean, values), []);
  assert.match(clean, /<second-device-key>/);
});

test("the report names each step and criterion within 80 columns", () => {
  const text = buildReport({
    c1: { status: "pass" },
    c2: { status: "fail", detail: "missing x", last: "a\nb" },
  });
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[0], "LIVE JOBS CHECK");
  assert.ok(lines.includes("c1                   pass"));
  assert.ok(lines.includes("research-job         pass"));
  assert.ok(lines.includes("steer-mid-job        fail"));
  assert.ok(lines.includes("capacity-line        not run"));
  assert.ok(lines.every((line) => line.length <= 80));
});

test("each command refuses missing or malformed arguments", () => {
  assert.equal(argumentProblem("preflight", {}), undefined);
  assert.match(argumentProblem("bogus", {}), /^usage: live-jobs\.mjs preflight/);
  for (const command of ["models", "charter", "stop-all", "capacity-line", "signals", "report"]) {
    assert.equal(argumentProblem(command, {}), `${command} needs --out <dir>`);
  }
  assert.equal(argumentProblem("charter", { out: "d" }), undefined);
  assert.equal(argumentProblem("charter", { out: "d", "max-usd": "10" }), undefined);
  assert.equal(
    argumentProblem("stop-all", { out: "d", "max-usd": "0" }),
    "--max-usd is a number 0-50",
  );
  assert.equal(
    argumentProblem("charter", { out: "d", "max-usd": "x" }),
    "--max-usd is a number 0-50",
  );
  assert.equal(
    argumentProblem("models", { out: "d", "max-usd": "5" }),
    "models takes no --max-usd",
  );
  assert.equal(
    argumentProblem("capacity-line", { out: "d" }),
    "capacity-line needs --measured-from <capacity.json>",
  );
  assert.equal(
    argumentProblem("capacity-line", { out: "d", "measured-from": "c.json" }),
    undefined,
  );
  assert.equal(argumentProblem("signals", { out: "d" }), "signals needs --since <epoch seconds>");
  assert.equal(
    argumentProblem("signals", { out: "d", since: "12" }),
    "signals needs --since <epoch seconds>",
  );
  assert.equal(argumentProblem("signals", { out: "d", since: "1793000000" }), undefined);
  assert.equal(
    argumentProblem("signals", { out: "d", since: "1793000000", until: "1792999999" }),
    "--until comes after --since",
  );
});

test("the measured number goes back as capacity.json holds it, or is cleared", () => {
  assert.deepEqual(measuredBack({ measured: 6, on: "2026-10-29" }), {
    measured: 6,
    at: Date.UTC(2026, 9, 29),
  });
  assert.deepEqual(measuredBack({ measured: null, on: "2026-10-29" }), {
    measured: null,
    at: null,
  });
  assert.deepEqual(measuredBack(undefined), { measured: null, at: null });
});

test("the signals file has one line per signal and a column per cell", () => {
  const lines = signalLines({ "job.started": { owner: 9, second: 2, household: 1 } }, "1", "2");
  assert.equal(lines[0], "SIGNALS  1 to 2 (epoch seconds)");
  assert.equal(lines.length, LIVE_SIGNALS.length + 2);
  assert.match(lines[2], /^job\.started +9 +2 +1$/);
  assert.match(lines.at(-1), /^capacity\.passed +\? +\? +\?$/);
  assert.ok(lines.every((line) => line.length <= 80));
  assert.deepEqual(LIVE_CELLS, ["owner", "second", "household"]);
});

test("the report passes only with every step, the owner's alert word, and every file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-jobs-report-"));
  const log = console.log;
  console.log = () => {};
  try {
    const pass = { status: "pass" };
    const charter = Object.fromEntries(
      ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => [id, pass]),
    );
    await writeFile(join(dir, "results-charter.json"), JSON.stringify(charter));
    await writeFile(join(dir, "results-stop-all.json"), JSON.stringify({ s7: pass }));
    await writeFile(
      join(dir, "results-capacity-line.json"),
      JSON.stringify({ k1: pass, alert: { status: "fail" } }),
    );
    assert.equal(await report({ out: dir }), 1);
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /^capacity alert +fail$/m);
    assert.match(summary, /^charter-1\.txt +missing$/m);
    await writeFile(
      join(dir, "results-capacity-line.json"),
      JSON.stringify({ k1: pass, alert: pass }),
    );
    for (const file of [
      "models-live.txt",
      ...[1, 2, 3, 4, 5, 6].map((n) => `charter-${n}.txt`),
      "stop-all.txt",
      "capacity-line.txt",
      "signals.txt",
    ]) {
      await writeFile(join(dir, file), "x\n");
    }
    assert.equal(await report({ out: dir }), 0);
    const passed = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(passed, /^stop-all +pass$/m);
    assert.ok(passed.split("\n").every((line) => line.length <= 80));
  } finally {
    console.log = log;
    await rm(dir, { recursive: true, force: true });
  }
});
