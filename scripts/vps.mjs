#!/usr/bin/env node
// Client for the VPS release tool (infra/ansible/roles/deploy_users/files/secbot-release).
// Node standard library only: deploy and check jobs run without node_modules.
//
//   node scripts/vps.mjs stage   --version V --sha256 S --file F
//   node scripts/vps.mjs deploy  --env test-cell|production --version V [--sha256 S] [--cells C]
//   node scripts/vps.mjs dry-run
//   node scripts/vps.mjs check-cells --env test-cell|production [--version V] [--cells owner,second]
//   node scripts/vps.mjs check-alarms --env test-cell|production [--cells person,household]
//   node scripts/vps.mjs durability --env test-cell [--crash-only] [--down-seconds 90]
//
// The SSH target is SECBOT_VPS_SSH, an alias in the caller's SSH config. In GitHub Actions the
// vps-access action writes the alias "secbot-vps", which is the default there. The repo never
// holds the VPS address.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_ARG = /^[A-Za-z0-9._+:,-]+$/;

export function sshTarget(env = process.env) {
  const target = env.SECBOT_VPS_SSH ?? (env.GITHUB_ACTIONS === "true" ? "secbot-vps" : undefined);
  if (!target) {
    throw new Error(
      "SECBOT_VPS_SSH is not set. Set it to the SSH config alias of the VPS (for example in your shell profile); the address never goes in the repo.",
    );
  }
  return target;
}

/** Builds the remote request; every word is checked, because it reaches the VPS as text. */
export function remoteCommand(words) {
  for (const word of words) {
    if (!SAFE_ARG.test(word))
      throw new Error(`refusing argument "${word}": only [A-Za-z0-9._+:,-] may reach the VPS`);
  }
  return words.join(" ");
}

/** Runs the release tool over SSH; resolves with stdout, streams stderr. */
export function runRemote(words, { input, target = sshTarget(), echo = true } = {}) {
  const command = remoteCommand(words);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", target, command], {
      stdio: [input ? "pipe" : "ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    if (input) createReadStream(input).pipe(child.stdin);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`the VPS release tool exited with ${code} for: ${words[0]}`));
    });
  });
}

const flags = (argv) =>
  parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      sha256: { type: "string" },
      file: { type: "string" },
      env: { type: "string" },
      cells: { type: "string" },
      "crash-only": { type: "boolean" },
      "down-seconds": { type: "string" },
    },
  }).values;

export async function stage({ version, sha256, file }) {
  if (!version || !sha256 || !file) throw new Error("stage needs --version, --sha256, and --file");
  return runRemote(["stage", "--version", version, "--sha256", sha256], { input: file });
}

export async function deploy({ env, version, sha256, cells }) {
  if (!env || !version) throw new Error("deploy needs --env and --version");
  if (env !== "test-cell" && env !== "production") throw new Error(`unknown environment "${env}"`);
  const words = ["deploy", "--env", env, "--version", version];
  if (sha256) words.push("--sha256", sha256);
  if (cells) words.push("--cells", cells);
  return runRemote(words);
}

/** No credentials: prints what the built bundle contains. The diff against a live cell runs in deploy. */
export async function dryRun() {
  const manifest = JSON.parse(await readFile(join(root, "dist", "manifest.json"), "utf8"));
  console.log(`dry-run: bundle ${manifest.version}, contract step ${manifest.contractStep}`);
  for (const file of manifest.files)
    console.log(`  ${file.sha256.slice(0, 12)}  ${file.bytes}\t${file.path}`);
  console.log(
    "dry-run: deploy --env test-cell prints the diff against the deployed bundle before it switches",
  );
}

/** The person cells of wave 1; the household cell joins with its own change. */
export const DEFAULT_CELLS = "owner,second";

/**
 * Turns the release tool's health answer into the check:cells phrases. A cell passes when it is up
 * and, with --version, on that version. Pure, so the phrases are tested without a VPS.
 */
export function reportCells(health, { cells = DEFAULT_CELLS, version } = {}) {
  const lines = [];
  let ok = true;
  for (const name of cells.split(",").filter(Boolean)) {
    const cell = health?.cells?.[name];
    if (cell === undefined || cell.status !== "up") {
      ok = false;
      lines.push(`cell ${name} down: ${cell?.reason ?? "no answer"}`);
    } else if (version !== undefined && cell.version !== version) {
      ok = false;
      lines.push(`cell ${name} up ${cell.version} (expected ${version})`);
    } else {
      lines.push(`cell ${name} up ${cell.version}`);
    }
  }
  return { ok, lines };
}

export async function checkCells({ env, version, cells = DEFAULT_CELLS }) {
  if (env !== "test-cell" && env !== "production")
    throw new Error("check-cells needs --env test-cell|production");
  const stdout = await runRemote(["health", "--env", env, "--cells", cells], { echo: false });
  let health;
  try {
    health = JSON.parse(stdout);
  } catch {
    throw new Error("the VPS health answer was not JSON");
  }
  const report = reportCells(health, { cells, version });
  for (const line of report.lines) console.log(line);
  if (!report.ok) throw new Error("one or more cells are down or on another version");
}

/** The cells check:alarms reads when no --cells is given; `person` stands for every person cell. */
export const DEFAULT_ALARM_CELLS = "person,household";
const PERSON_CELLS = ["owner", "second"];

export const expandCells = (cells) => [
  ...new Set(
    cells
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .flatMap((name) => (name === "person" ? PERSON_CELLS : [name])),
  ),
];

const at = (ms) => (ms === null || ms === undefined ? "none" : new Date(ms).toISOString());

/**
 * Turns the release tool's alarm answer into the check:alarms phrases, which the alarm-lost
 * runbook matches. A cell passes when its stored alarm is at or before its earliest stored timer.
 * Pure, so the phrases are tested without a VPS.
 */
export function reportAlarms(answer, { cells = DEFAULT_ALARM_CELLS } = {}) {
  const lines = [];
  let ok = true;
  for (const name of expandCells(cells)) {
    const cell = answer?.cells?.[name];
    if (cell === undefined || (cell.ok === false && cell.problem === undefined)) {
      ok = false;
      lines.push(`cell ${name} down: ${cell?.reason ?? "no answer"}`);
    } else if (cell.problem === "no next alarm") {
      ok = false;
      lines.push(`cell ${name}: no next alarm (earliest timer ${cell.earliest ?? "none"})`);
    } else if (cell.problem === "alarm mismatch") {
      ok = false;
      lines.push(
        `cell ${name}: alarm mismatch: alarm ${cell.alarm} later than earliest timer ${cell.earliest} (${cell.earliestSource})`,
      );
    } else if (cell.earliest === null) {
      lines.push(`cell ${name} alarm ok: no timers`);
    } else {
      lines.push(
        `cell ${name} alarm ok ${cell.alarm} (earliest timer ${cell.earliest}, ${cell.earliestSource})`,
      );
    }
  }
  return { ok, lines };
}

const parseJson = (stdout, what) => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`the VPS ${what} answer was not JSON`);
  }
};

export async function checkAlarms({ env, cells = DEFAULT_ALARM_CELLS }) {
  if (env !== "test-cell" && env !== "production")
    throw new Error("check-alarms needs --env test-cell|production");
  const stdout = await runRemote(["alarms", "--env", env, "--cells", cells], { echo: false });
  const report = reportAlarms(parseJson(stdout, "alarm"), { cells });
  for (const line of report.lines) console.log(line);
  if (!report.ok) throw new Error("one or more cells have no next alarm or a late one");
}

const ROUTINE_PREFIX = "secbot.routine:";

/**
 * The crash case on the test cell (AC-19, AC-21): `before` is the lab state before arming,
 * `armed` the arm answer, `after` the state after the SIGKILL and the restart, once idle. Pure.
 */
export function judgeCrash(before, armed, after) {
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
  check(
    "crash-restarted",
    after.startedAt > armed.armedAt && armed.specialistCallStarted === true,
    `the lab started again at ${at(after.startedAt)}`,
  );
  check(
    "crash-conversation",
    after.armed === true && after.leadEntries > before.leadEntries,
    `lead entries ${before.leadEntries} before, ${after.leadEntries} after`,
  );
  check(
    "crash-no-partial-write",
    after.markerRows === before.markerRows,
    `marker rows ${before.markerRows} before, ${after.markerRows} after (the open transaction's row must be gone)`,
  );
  const reminder = (after.tasks ?? []).find(
    (task) => task.kind === `${ROUTINE_PREFIX}reminder` && task.id === armed.reminderTaskId,
  );
  check(
    "crash-timer",
    reminder !== undefined && reminder.wakeAt === armed.reminderAt,
    reminder === undefined ? "the reminder task is gone" : `reminder wake ${at(reminder.wakeAt)}`,
  );
  check(
    "crash-job-and-cut-off-call",
    after.followupReported === true && (after.calls?.specialist ?? 0) >= 1,
    `specialist calls after the restart: ${after.calls?.specialist ?? 0}; answer relayed: ${after.followupReported}`,
  );
  check(
    "crash-alarm",
    after.alarm !== null && after.earliest !== null && after.alarm === after.earliest?.at,
    `alarm ${at(after.alarm)}, earliest timer ${at(after.earliest?.at)}`,
  );
  return results;
}

/** The late-alarm case (AC-20): the cell was down from `down.downFrom` to `down.upAt`. Pure. */
export function judgeLateAlarm(down, after) {
  const overdue = (after.ticks ?? []).filter(
    (tick) => tick.wakeAt <= down.upAt && tick.firedAt >= down.downFrom,
  );
  const tick = (after.tasks ?? []).find((task) => task.kind === `${ROUTINE_PREFIX}lab-tick`);
  return [
    {
      name: "late-alarm-runs-once",
      pass: overdue.length === 1,
      detail: `lab-tick runs for wake times inside the ${Math.round((down.upAt - down.downFrom) / 1000)} s down window: ${overdue.length}`,
    },
    {
      name: "late-alarm-moves-on",
      pass:
        tick !== undefined &&
        tick.wakeAt > down.upAt &&
        after.alarm !== null &&
        after.earliest !== null &&
        after.alarm === after.earliest?.at,
      detail: `next lab-tick ${at(tick?.wakeAt)}, alarm ${at(after.alarm)}`,
    },
  ];
}

const lab = async (env, route, extra = []) =>
  parseJson(
    await runRemote(["lab", "--env", env, "--route", route, ...extra], { echo: false }),
    `lab ${route}`,
  );

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function labUntil(env, ready, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await lab(env, "state");
    if (ready(state) || Date.now() > deadline) return state;
    await pause(5_000);
  }
}

export const printResults = (results, log = console.log) => {
  for (const result of results) {
    log(`durability ${result.name} ${result.pass ? "pass" : "fail"}: ${result.detail}`);
  }
  return results.every((result) => result.pass);
};

/**
 * Drives the test cell's durability lab: a SIGKILL with three things in flight, a late alarm after
 * the cell was down, the household round trip, and the induced alarm checks. With --crash-only, it
 * only kills the test cell and waits for it to come back (Charter Scenario step 7).
 */
export async function durability({ env, "crash-only": crashOnly, "down-seconds": downSeconds }) {
  if (env !== "test-cell") throw new Error("durability runs only with --env test-cell");
  if (crashOnly) {
    await runRemote(["crash", "--env", env]);
    return;
  }
  const results = [];
  const before = await labUntil(env, (state) => state.liveUntimed === 0, 120_000);
  const armed = await lab(env, "arm");
  await runRemote(["crash", "--env", env]);
  const after = await labUntil(
    env,
    (state) => state.followupReported === true && state.liveUntimed === 0,
    300_000,
  );
  results.push(...judgeCrash(before, armed, after));

  const down = parseJson(
    await runRemote(["down", "--env", env, "--seconds", downSeconds ?? "90"], { echo: false }),
    "down",
  );
  const late = await labUntil(
    env,
    (state) => (state.ticks ?? []).some((tick) => tick.firedAt >= down.downFrom),
    120_000,
  );
  results.push(...judgeLateAlarm(down, late));

  const household = await lab(env, "household-roundtrip");
  results.push({
    name: "household-roundtrip",
    pass: household.ok === true,
    detail: `second cell copies of the owner's item: ${household.copies ?? 0}; retry applied once: ${household.retried?.duplicate ?? false}`,
  });

  // The alarm check fails on an induced late alarm and on a missing one, then passes after a re-arm.
  const report = await lab(env, "alarm-report");
  const earliest = Date.parse(report.earliest);
  const judgeInduced = async (name, set, problem) => {
    await lab(env, "alarm", ["--at", set]);
    const answer = parseJson(
      await runRemote(["alarms", "--env", env, "--cells", "lab"], { echo: false }),
      "alarm",
    );
    const verdict = reportAlarms(answer, { cells: "lab" });
    results.push({
      name,
      pass: !verdict.ok && verdict.lines.some((line) => line.includes(problem)),
      detail: verdict.lines.join("; "),
    });
  };
  await judgeInduced("check-alarms-late", String(earliest + 3_600_000), "alarm mismatch");
  await judgeInduced("check-alarms-missing", "none", "no next alarm");
  await lab(env, "rearm");
  const healed = reportAlarms(
    parseJson(
      await runRemote(["alarms", "--env", env, "--cells", "lab"], { echo: false }),
      "alarm",
    ),
    { cells: "lab" },
  );
  results.push({ name: "check-alarms-rearmed", pass: healed.ok, detail: healed.lines.join("; ") });

  if (!printResults(results)) throw new Error("one or more durability cases failed");
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "stage") await stage(flags(rest));
  else if (command === "deploy") await deploy(flags(rest));
  else if (command === "dry-run") await dryRun();
  else if (command === "check-cells") await checkCells(flags(rest));
  else if (command === "check-alarms") await checkAlarms(flags(rest));
  else if (command === "durability") await durability(flags(rest));
  else
    throw new Error(
      "usage: vps.mjs stage|deploy|dry-run|check-cells|check-alarms|durability [flags]",
    );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`vps: ${error.message}`);
    process.exit(1);
  });
}
