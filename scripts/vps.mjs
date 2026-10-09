#!/usr/bin/env node
// Client for the VPS release tool (infra/ansible/roles/deploy_users/files/secbot-release).
// Node standard library only: deploy and check jobs run without node_modules.
//
//   node scripts/vps.mjs stage   --version V --sha256 S --file F
//   node scripts/vps.mjs deploy  --env test-cell|production --version V [--sha256 S] [--cells C]
//   node scripts/vps.mjs dry-run
//   node scripts/vps.mjs check-cells --env test-cell|production [--version V] [--cells C]
//   node scripts/vps.mjs check-alarms --env test-cell|production [--cells C]
//   node scripts/vps.mjs check-heartbeats [--since-deploy] [--cells C] [--env E]
//   node scripts/vps.mjs alert-drill --env test-cell [--down-seconds 420]
//   node scripts/vps.mjs durability --env test-cell [--crash-only] [--down-seconds 90]
//   node scripts/vps.mjs snapshot --env E --snapshot-id ID
//   node scripts/vps.mjs ledger-record --kind release|rollback|restore [--version V] [--cells C]
//                                      [--snapshot-id ID] [--run-id R --run-attempt A]
//   node scripts/vps.mjs ledger-verify --kind K [--version V] [--cells C] --run-id R --run-attempt A
//   node scripts/vps.mjs restore --env E --cells CELL --snapshot ID
//   node scripts/vps.mjs drill [--snapshot ID] [--cells owner]
//   node scripts/vps.mjs integration --env test-cell
//   node scripts/vps.mjs lease acquire|release --holder H [--seconds N]
//   node scripts/vps.mjs measure-heap --env test-cell [--seconds 180]
//   node scripts/vps.mjs measure-write-delay --env test-cell [--writes 200]
//   node scripts/vps.mjs measure-guard --env test-cell [--calls 100] [--adapter clef|clef-flash|jev]
//
// Cell names follow the release workflows: owner, person (the second person's cell), household,
// and secrets. With no --cells, a command covers every cell of the environment. The secrets cell
// is never snapshotted or restored, and keeps no heartbeat until the owner adds one, so
// check-heartbeats skips it with a printed line.
//
// The SSH target is SECBOT_VPS_SSH, an alias in the caller's SSH config. In GitHub Actions the
// vps-access action writes the alias "secbot-vps", which is the default there. The repo never
// holds the VPS address.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fetchHeartbeatStatuses, heartbeatName } from "./betterstack.mjs";

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

/** Commands that take the VPS lock; inside a lease they pass its holder. */
const LOCKING = new Set([
  "stage",
  "deploy",
  "conformance",
  "lab",
  "crash",
  "down",
  "snapshot",
  "restore",
  "drill",
  "wipe",
  "write-delay",
  "ledger-record",
]);
let leaseHolder;

export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
];

/** Runs the release tool over SSH; resolves with stdout, streams stderr. */
export function runRemote(words, { input, target = sshTarget(), echo = true } = {}) {
  const command = remoteCommand(
    leaseHolder !== undefined && LOCKING.has(words[0])
      ? [...words, "--holder", leaseHolder]
      : words,
  );
  return new Promise((resolvePromise, reject) => {
    // Keepalives end a session on a dropped link within about a minute, instead of holding the
    // VPS lock until the job's own timeout.
    const child = spawn("ssh", [...SSH_OPTIONS, target, command], {
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
      else {
        // A refused cell answers with {"error": ...}; print it, so the runbook phrases reach the log.
        if (!echo && stdout.trim() !== "") process.stderr.write(stdout);
        reject(new Error(`the VPS release tool exited with ${code} for: ${words[0]}`));
      }
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
      "snapshot-id": { type: "string" },
      snapshot: { type: "string" },
      kind: { type: "string" },
      "run-id": { type: "string" },
      "run-attempt": { type: "string" },
      "since-deploy": { type: "boolean" },
      holder: { type: "string" },
      seconds: { type: "string" },
      writes: { type: "string" },
      calls: { type: "string" },
      adapter: { type: "string" },
    },
    allowPositionals: true,
  }).values;

/** Every cell, by the cells' own names. */
export const DEFAULT_CELLS = "owner,second,household,secrets";
/** Printed when check-heartbeats leaves out the secrets cell. */
export const SECRETS_HEARTBEAT_SKIPPED =
  "cell secrets skipped: it keeps no heartbeat until the owner adds one";

/**
 * The release workflows' cell names to the cells' own: `person` is the second person's cell;
 * no names means every cell.
 */
export function normalizeCells(cells) {
  const named = (cells ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (named.length === 0) return DEFAULT_CELLS.split(",");
  return [...new Set(named.map((name) => (name === "person" ? "second" : name)))];
}

/** The cells check-heartbeats asks about: every named cell but the secrets cell. */
export function heartbeatCells(cells, log = () => {}) {
  const named = normalizeCells(cells);
  if (named.includes("secrets")) log(SECRETS_HEARTBEAT_SKIPPED);
  return named.filter((name) => name !== "secrets");
}

const runWords = (env = process.env) =>
  env.GITHUB_RUN_ID
    ? ["--run-id", env.GITHUB_RUN_ID, "--run-attempt", env.GITHUB_RUN_ATTEMPT ?? "1"]
    : [];

/**
 * Compares the release tool on the VPS with the copy the bundle was built with. The VPS copy is
 * installed by host setup only, so a release that changed the tool needs host setup first.
 */
export function judgeTool(remoteSha, localSha) {
  const remote = remoteSha.trim();
  if (localSha === undefined) return { ok: true, line: "release tool: no local copy to compare" };
  if (remote === localSha) return { ok: true, line: `release tool ${remote.slice(0, 12)} matches` };
  return {
    ok: false,
    line: `the release tool on the VPS (${remote.slice(0, 12) || "unknown"}) differs from this bundle's (${localSha.slice(0, 12)}); run "mise run host:setup" first`,
  };
}

/** SHA-256 of the bundle's copy of the release tool, or undefined when there is none. */
async function localToolSha() {
  const file = join(root, "dist", "vps", "secbot-release");
  const bytes = await readFile(file).catch(() => undefined);
  return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

export async function checkTool() {
  const verdict = judgeTool(await runRemote(["tool-sha"], { echo: false }), await localToolSha());
  console.log(verdict.line);
  if (!verdict.ok) throw new Error(verdict.line);
}

export async function stage({ version, sha256, file }) {
  if (!version || !sha256 || !file) throw new Error("stage needs --version, --sha256, and --file");
  await checkTool();
  return runRemote(["stage", "--version", version, "--sha256", sha256], { input: file });
}

export async function deploy({ env, version, sha256, cells }) {
  if (!env || !version) throw new Error("deploy needs --env and --version");
  if (env !== "test-cell" && env !== "production") throw new Error(`unknown environment "${env}"`);
  const words = ["deploy", "--env", env, "--version", version];
  if (sha256) words.push("--sha256", sha256);
  if (cells) {
    const named = normalizeCells(cells);
    if (named.length === 0) {
      console.log("deploy: no cell to deploy");
      return "";
    }
    words.push("--cells", named.join(","));
  }
  words.push(...runWords());
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

/**
 * Turns the release tool's health answer into the check:cells phrases. A cell passes when it is up
 * and, with --version, on that version. Pure, so the phrases are tested without a VPS.
 */
export function reportCells(health, { cells = DEFAULT_CELLS, version } = {}) {
  const lines = [];
  let ok = true;
  for (const name of normalizeCells(cells)) {
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
  const named = normalizeCells(cells);
  if (named.length === 0) return;
  cells = named.join(",");
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

/** The cells check:alarms reads when no --cells is given: every cell. */
export const DEFAULT_ALARM_CELLS = DEFAULT_CELLS;

export const expandCells = (cells) => normalizeCells(cells);

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
  const named = normalizeCells(cells);
  if (named.length === 0) return;
  cells = named.join(",");
  const stdout = await runRemote(["alarms", "--env", env, "--cells", cells], { echo: false });
  const report = reportAlarms(parseJson(stdout, "alarm"), { cells });
  for (const line of report.lines) console.log(line);
  if (!report.ok) throw new Error("one or more cells have no next alarm or a late one");
}

const ROUTINE_PREFIX = "secbot.routine:";

/**
 * The crash case on the test cell: `before` is the lab state before arming,
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

/** The late-alarm case: the cell was down from `down.downFrom` to `down.upAt`. Pure. */
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
 * only kills the test cell and waits for it to come back.
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

// ---- snapshots, ledger, restore, drill -------------------------------------------------------

const short = (digest) => String(digest ?? "").slice(0, 12);

export async function snapshot({ env, "snapshot-id": id }) {
  if (!env || !id) throw new Error("snapshot needs --env and --snapshot-id");
  const answer = parseJson(
    await runRemote(["snapshot", "--env", env, "--snapshot-id", id], { echo: false }),
    "snapshot",
  );
  for (const item of answer.snapshots ?? []) {
    console.log(
      `snapshot ${item.cell} ok digest ${short(item.digest)} rows ${item.rows} bytes ${item.bytes}`,
    );
  }
  console.log(
    `snapshot ${id}: ${(answer.snapshots ?? []).length} cells, contract step ${answer.contractStep}`,
  );
  return answer;
}

export async function ledgerRecord(values) {
  const { kind } = values;
  if (!["release", "rollback", "restore"].includes(kind ?? "")) {
    throw new Error("ledger-record needs --kind release|rollback|restore");
  }
  const words = ["ledger-record", "--kind", kind];
  for (const name of ["version", "snapshot-id", "run-id", "run-attempt"]) {
    if (values[name]) words.push(`--${name}`, values[name]);
  }
  if (values.cells) words.push("--cells", normalizeCells(values.cells).join(","));
  await runRemote(words);
}

/**
 * ledger:verify. Passes only when the newest release, rollback, or restore record is this run's
 * attempt of `kind`, and no deploy from another run or by hand came after it. Pure.
 */
export function judgeLedger(records, { kind, runId, runAttempt, version }) {
  const decisive = records.filter((record) =>
    ["release", "rollback", "restore"].includes(record.kind),
  );
  const newest = decisive.at(-1);
  if (newest === undefined) {
    return { ok: false, line: "ledger: no approved release, rollback, or restore is recorded" };
  }
  const describe = (record) =>
    record.runId ? `run ${record.runId} attempt ${record.runAttempt}` : "a hand run";
  if (
    newest.kind !== kind ||
    String(newest.runId ?? "") !== String(runId) ||
    String(newest.runAttempt ?? "") !== String(runAttempt)
  ) {
    return {
      ok: false,
      line: `ledger: the newest record is ${newest.kind} from ${describe(newest)}, not this ${kind} (run ${runId} attempt ${runAttempt})`,
    };
  }
  if (version && newest.version && newest.version !== version) {
    return {
      ok: false,
      line: `ledger: the newest ${kind} is for ${newest.version}, not ${version}`,
    };
  }
  const later = records
    .slice(records.lastIndexOf(newest) + 1)
    .find((record) => record.kind === "deploy" && String(record.runId ?? "") !== String(runId));
  if (later !== undefined) {
    return {
      ok: false,
      line: `ledger: a newer deploy of ${later.version} from ${describe(later)} at ${later.at} came after this ${kind}`,
    };
  }
  return { ok: true, line: `ledger ok: ${kind} run ${runId} attempt ${runAttempt} is the newest` };
}

export async function ledgerVerify(values) {
  const { kind } = values;
  if (!kind || !values["run-id"] || !values["run-attempt"]) {
    throw new Error("ledger-verify needs --kind, --run-id, and --run-attempt");
  }
  const stdout = await runRemote(["ledger-read"], { echo: false });
  const records = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const verdict = judgeLedger(records, {
    kind,
    runId: values["run-id"],
    runAttempt: values["run-attempt"],
    version: values.version,
  });
  console.log(verdict.line);
  if (!verdict.ok)
    throw new Error("the deploy ledger does not hold this approved attempt as the newest");
}

/** A restore's answer against the snapshot it loaded. Pure. */
export function judgeRestore(answer, cell) {
  if (answer?.cell !== cell || typeof answer?.digest !== "string") {
    return {
      ok: false,
      line: `restore ${cell} failed: ${answer?.error ?? "no digest in the answer"}`,
    };
  }
  return {
    ok: true,
    line: `restore ${cell} ok digest ${short(answer.digest)} rows ${answer.rows}`,
  };
}

export async function restore({ env, cells, snapshot: id }) {
  if (!env || !cells || !id) throw new Error("restore needs --env, --cells, and --snapshot");
  if (cells.split(",").includes("secrets")) {
    throw new Error("the secrets cell is never restored: rebuild it and rotate its credentials");
  }
  const named = normalizeCells(cells);
  if (named.length !== 1) throw new Error("restore takes exactly one cell");
  const [cell] = named;
  const answer = parseJson(
    await runRemote(["restore", "--env", env, "--cells", cell, "--snapshot", id], { echo: false }),
    "restore",
  );
  const verdict = judgeRestore(answer, cell);
  console.log(verdict.line);
  if (!verdict.ok) throw new Error("the restore did not report the loaded digest");
  console.log("outbound-effects log: none in this release (no tool has an outside effect yet)");
}

export async function drill({ snapshot: id, cells = "owner" }) {
  if (cells.split(",").includes("secrets")) {
    throw new Error("the secrets cell is never restored: rebuild it and rotate its credentials");
  }
  const named = normalizeCells(cells);
  const words = ["drill", "--cells", named.join(",")];
  if (id) words.push("--snapshot", id);
  const answer = parseJson(await runRemote(words, { echo: false }), "drill");
  let ok = true;
  for (const item of answer.restored ?? []) {
    const verdict = judgeRestore(item, item.cell);
    ok &&= verdict.ok;
    console.log(`drill ${answer.snapshot}: ${verdict.line}`);
  }
  console.log("drill: the test cell holds real data until its next deploy wipes it");
  if (!ok || (answer.restored ?? []).length === 0) throw new Error("the restore drill failed");
}

// ---- heartbeats -------------------------------------------------------------------------------

/**
 * check:heartbeats. A cell passes when Better Stack lists its heartbeat as up and the cell's own
 * last 2xx ping is after its fleet's deploy (with --since-deploy). Pure.
 */
export function reportHeartbeats(answer, statuses, { sinceDeploy = false } = {}) {
  const lines = [];
  let ok = true;
  const fail = (line) => {
    ok = false;
    lines.push(line);
  };
  const env = answer?.env;
  for (const [cell, state] of Object.entries(answer?.cells ?? {})) {
    const name = heartbeatName(env === "test-cell" ? "test" : cell);
    const status = statuses.get(name);
    if (state?.error !== undefined) fail(`heartbeat ${cell} missing: ${state.error}`);
    else if (status === undefined) fail(`heartbeat ${cell} missing in Better Stack ("${name}")`);
    else if (status !== "up") fail(`heartbeat ${cell} down in Better Stack (status ${status})`);
    else if (state?.lastOkAt === null || state?.lastOkAt === undefined) {
      fail(
        `heartbeat ${cell} missing: no 2xx ping yet (last outcome ${state?.lastOutcome ?? "none"})`,
      );
    } else if (
      sinceDeploy &&
      typeof state.deployedAt === "number" &&
      state.lastOkAt < state.deployedAt
    ) {
      fail(
        `heartbeat ${cell} stale: last ok ping ${at(state.lastOkAt)} before the deploy at ${at(state.deployedAt)}`,
      );
    } else {
      lines.push(`heartbeat ${cell} fresh: last ok ping ${at(state.lastOkAt)}`);
    }
  }
  if (lines.length === 0) fail("heartbeat: no cell answered");
  return { ok, lines };
}

export async function checkHeartbeats(values, fetcher = fetch) {
  const named = heartbeatCells(values.cells, console.log);
  if (named.length === 0) return;
  // The SSH user picks the environment (deploy-test: the test cell; deploy: production).
  const words = ["heartbeats", "--cells", named.join(",")];
  if (values.env) words.push("--env", values.env);
  const answer = parseJson(await runRemote(words, { echo: false }), "heartbeats");
  const statuses = await fetchHeartbeatStatuses(process.env.HEARTBEAT_API_TOKEN, fetcher);
  const report = reportHeartbeats(answer, statuses, { sinceDeploy: values["since-deploy"] });
  for (const line of report.lines) console.log(line);
  if (!report.ok) throw new Error("one or more heartbeats are missing, down, or stale");
}

/**
 * The induced heartbeat alert: the test cell stops for longer than its heartbeat's period
 * and grace, so Better Stack alerts the owner by push and e-mail; then it starts again.
 */
export async function alertDrill({ env, "down-seconds": seconds = "420" }) {
  if (env !== "test-cell") throw new Error("alert-drill runs only with --env test-cell");
  console.log(
    `alert drill: stopping the test cell for ${seconds} s (heartbeat period 300 s, grace 60 s)`,
  );
  const down = parseJson(
    await runRemote(["down", "--env", env, "--seconds", seconds], { echo: false }),
    "down",
  );
  console.log(
    `alert drill: the test cell was down from ${at(down.downFrom)} to ${at(down.upAt)}; confirm the push and the e-mail, then run check:heartbeats`,
  );
}

// ---- the VPS lease ----------------------------------------------------------------------------

export async function lease({ holder, seconds = "3600" }, action) {
  if (action !== "acquire" && action !== "release")
    throw new Error("lease acquire|release --holder H");
  if (!holder) throw new Error("lease needs --holder");
  const words = ["lease", action, "--holder", holder];
  if (action === "acquire") words.push("--seconds", seconds);
  await runRemote(words);
}

/** Runs `work` inside a lease, so no deploy or other run touches the VPS in between. */
async function withLease(name, work) {
  const holder = `${name}-${Date.now()}`;
  await lease({ holder, seconds: "3600" }, "acquire");
  leaseHolder = holder;
  try {
    return await work();
  } finally {
    leaseHolder = undefined;
    await lease({ holder }, "release").catch((error) => console.error(`vps: ${error.message}`));
  }
}

// ---- the integration suite --------------------------------------------------------------------

const digests = async (env, cells) =>
  parseJson(await runRemote(["digest", "--env", env, "--cells", cells], { echo: false }), "digest")
    .cells ?? {};

/**
 * The release integration suite on the test cell, under one lease: the durability lab, a snapshot
 * round trip (snapshot, change the household list, restore, compare digests), and the alarm check.
 */
export async function integration({ env }) {
  if (env !== "test-cell") throw new Error("integration runs only with --env test-cell");
  await withLease("integration", async () => {
    const results = [];
    try {
      await durability({ env });
      results.push({ name: "durability", pass: true, detail: "every durability case passed" });
    } catch (error) {
      results.push({ name: "durability", pass: false, detail: error.message });
    }
    const id = `integration-${Date.now()}`;
    const taken = parseJson(
      await runRemote(["snapshot", "--env", env, "--snapshot-id", id], { echo: false }),
      "snapshot",
    );
    const household = (taken.snapshots ?? []).find((item) => item.cell === "household");
    await lab(env, "household-roundtrip");
    const changed = (await digests(env, "household")).household?.digest;
    const restored = parseJson(
      await runRemote(["restore", "--env", env, "--cells", "household", "--snapshot", id], {
        echo: false,
      }),
      "restore",
    );
    const after = (await digests(env, "household")).household?.digest;
    results.push({
      name: "snapshot-roundtrip",
      pass:
        household !== undefined &&
        changed !== household.digest &&
        // The restore's own digest is read back inside its transaction; a digest taken after the
        // cell reopens can include a routine that ran on open, so it is reported, not compared.
        restored.digest === household.digest,
      detail: `household digest ${short(household?.digest)} at the snapshot, ${short(changed)} after a change, ${short(restored.digest)} restored, ${short(after)} after the reopen; bytes per cell: ${(taken.snapshots ?? []).map((item) => `${item.cell} ${item.bytes}`).join(", ")}`,
    });
    const alarms = parseJson(
      await runRemote(["alarms", "--env", env, "--cells", DEFAULT_CELLS], { echo: false }),
      "alarm",
    );
    const verdict = reportAlarms(alarms);
    results.push({ name: "check-alarms", pass: verdict.ok, detail: verdict.lines.join("; ") });
    for (const result of results) {
      console.log(`integration ${result.name} ${result.pass ? "pass" : "fail"}: ${result.detail}`);
    }
    if (!results.every((result) => result.pass)) throw new Error("the integration suite failed");
  });
}

// ---- measurements -----------------------------------------------------------------------------

/** Median, 95th percentile (nearest rank), min, and max of durations in ms. Pure. */
export function summarizeDelays(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, p95: null, min: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { count: sorted.length, median, p95, min: sorted[0], max: sorted.at(-1) };
}

export async function measureWriteDelay({ env, writes = "200" }) {
  if (env !== "test-cell") throw new Error("measure-write-delay runs only with --env test-cell");
  await withLease("write-delay", async () => {
    const answer = parseJson(
      await runRemote(["write-delay", "--env", env, "--writes", writes], { echo: false }),
      "write-delay",
    );
    const summary = summarizeDelays(answer.ms ?? []);
    console.log(
      `write-delay: ${summary.count} committed single-row writes (after ${answer.warmup ?? 0} warm-up writes)`,
    );
    console.log(
      `write-delay median ${summary.median} ms, p95 ${summary.p95} ms, min ${summary.min} ms, max ${summary.max} ms`,
    );
  });
}

export const HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
const MIB = 1024 * 1024;

/**
 * The heap numbers of one celld /state sample (celld v0.6.1 docs/README.md:660-705): the RSS, and
 * the largest per-isolate heap among the current deployment's cell scripts. Pure.
 */
export function heapOfState(state) {
  let peakIsolate = 0;
  let total = 0;
  const cells = state?.deployment?.isolates?.cells ?? {};
  for (const entry of Object.values(cells)) {
    const heap = Number(entry?.heap_bytes ?? 0);
    const isolates = Math.max(1, Number(entry?.live ?? 0) + Number(entry?.retiring ?? 0));
    total += heap;
    peakIsolate = Math.max(peakIsolate, heap / isolates);
  }
  return { rss: Number(state?.rss_bytes ?? 0), heap: total, isolateHeap: peakIsolate };
}

/** The peaks over every sample, and the verdict against the heap limit. Pure. */
export function judgeHeap(samples, limit = HEAP_LIMIT_BYTES, fleet = "test") {
  let isolateHeap = 0;
  let heap = 0;
  let rss = 0;
  let vpsRss = 0;
  for (const sample of samples) {
    let sampleRss = 0;
    for (const [name, state] of Object.entries(sample.fleets ?? {})) {
      const numbers = heapOfState(state);
      sampleRss += numbers.rss;
      if (name !== fleet) continue;
      isolateHeap = Math.max(isolateHeap, numbers.isolateHeap);
      heap = Math.max(heap, numbers.heap);
      rss = Math.max(rss, numbers.rss);
    }
    vpsRss = Math.max(vpsRss, sampleRss);
  }
  return {
    ok: isolateHeap > 0 && isolateHeap < limit,
    isolateHeap,
    heap,
    rss,
    vpsRss,
    samples: samples.length,
  };
}

export async function measureHeap({ env, seconds = "180" }) {
  if (env !== "test-cell") throw new Error("measure-heap runs only with --env test-cell");
  await withLease("heap", async () => {
    await lab(env, "load");
    const samples = [];
    const end = Date.now() + Number(seconds) * 1000;
    while (Date.now() < end) {
      samples.push(parseJson(await runRemote(["state", "--env", "all"], { echo: false }), "state"));
      if (samples.length === 5) {
        const load = await lab(env, "load-state");
        console.log(
          `heap: lab load live tasks ${load.live}, specialist calls ${load.specialistCalls}`,
        );
      }
      await pause(1_000);
    }
    const verdict = judgeHeap(samples);
    const mib = (bytes) => (bytes / MIB).toFixed(1);
    console.log(`heap: ${verdict.samples} samples of celld /state over ${seconds} s`);
    console.log(
      `heap peak per isolate ${mib(verdict.isolateHeap)} MiB of the ${mib(HEAP_LIMIT_BYTES)} MiB limit; test fleet heaps ${mib(verdict.heap)} MiB, RSS ${mib(verdict.rss)} MiB; VPS celld RSS ${mib(verdict.vpsRss)} MiB`,
    );
    if (!verdict.ok) {
      throw new Error(
        "heap over the limit: raise celld_v8_heap_limit_mb and move developer work into its own cell",
      );
    }
    console.log("heap ok: fallback not needed");
  });
}

export const GUARD_BUDGET_MS = 500;
/** The decision-model adapters the bench can measure (DECISION_MODELS in the cell harness). */
export const GUARD_ADAPTERS = ["clef", "clef-flash", "jev"];

/** The `--adapter` value, or an error; undefined measures the bench cell's current adapter. Pure. */
export function guardAdapter(adapter) {
  if (adapter === undefined) return undefined;
  if (!GUARD_ADAPTERS.includes(adapter)) {
    throw new Error(`measure-guard needs --adapter ${GUARD_ADAPTERS.join("|")}`);
  }
  return adapter;
}
export const MAX_GUARD_CALLS = 200;

/** The `--calls` value as a whole number from 1 to 200, or an error. Pure. */
export function guardCalls(calls = "100") {
  const value = /^\d{1,3}$/.test(String(calls)) ? Number(calls) : Number.NaN;
  if (!(value >= 1 && value <= MAX_GUARD_CALLS)) {
    throw new Error(`measure-guard needs --calls 1-${MAX_GUARD_CALLS}`);
  }
  return value;
}

/**
 * The guard bench's verdict line: the rules plus the decision model must add
 * under 500 ms at p95 over every requested call, the reviewer excluded. A run where the decision
 * model fell back on most calls (the endpoint down or changed) is not a measurement. Pure.
 */
export function judgeGuardBench(results, calls, budgetMs = GUARD_BUDGET_MS) {
  const measured = Number(results?.measured ?? 0);
  const fallbacks = Object.entries(results?.fallbacks ?? {});
  const fellBack = fallbacks.reduce((sum, [, count]) => sum + Number(count), 0);
  if (measured === 0) return { ok: false, line: "not measured: no call was measured" };
  if (fellBack * 2 >= measured) {
    const causes = fallbacks.map(([cause, count]) => `${cause} ${count}`).join(", ");
    return {
      ok: false,
      line: `not measured: the decision model fell back on ${fellBack} of ${measured} calls (${causes})`,
    };
  }
  if (measured < calls) {
    return {
      ok: false,
      line: `not measured: only ${measured} of ${calls} calls were measured before the deadline`,
    };
  }
  const p95 = Number(results.p95Ms);
  const head = `guard added time p95 ${p95} ms over ${measured} calls (rules and decision model; reviewer excluded)`;
  return p95 < budgetMs
    ? { ok: true, line: `${head}: pass` }
    : { ok: false, line: `${head}: over the ${budgetMs} ms budget` };
}

/** The test cell's guard bench: starts it, waits for its result (up to 10 minutes), and judges it. */
export async function measureGuard({ env, calls = "100", adapter }) {
  if (env !== "test-cell") throw new Error("measure-guard runs only with --env test-cell");
  const count = guardCalls(calls);
  const chosen = guardAdapter(adapter);
  await withLease("guard-bench", async () => {
    await lab(env, "guard-bench", [
      "--calls",
      String(count),
      ...(chosen === undefined ? [] : ["--adapter", chosen]),
    ]);
    const deadline = Date.now() + 10 * 60_000;
    let state = {};
    for (;;) {
      await pause(5_000);
      state = await lab(env, "guard-bench-state");
      if (state.done === true || Date.now() > deadline) break;
    }
    if (state.done !== true)
      throw new Error("not measured: the guard bench did not finish in 10 minutes");
    console.log(JSON.stringify(state.results));
    const verdict = judgeGuardBench(state.results, count);
    console.log(verdict.line);
    if (!verdict.ok) throw new Error(verdict.line);
  });
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const values = () => flags(rest);
  if (command === "stage") await stage(flags(rest));
  else if (command === "snapshot") await snapshot(values());
  else if (command === "ledger-record") await ledgerRecord(values());
  else if (command === "ledger-verify") await ledgerVerify(values());
  else if (command === "restore") await restore(values());
  else if (command === "drill") await drill(values());
  else if (command === "check-heartbeats") await checkHeartbeats(values());
  else if (command === "alert-drill") await alertDrill(values());
  else if (command === "integration") await integration(values());
  else if (command === "lease") await lease(values(), rest[0]);
  else if (command === "measure-heap") await measureHeap(values());
  else if (command === "measure-write-delay") await measureWriteDelay(values());
  else if (command === "measure-guard") await measureGuard(values());
  else if (command === "deploy") await deploy(flags(rest));
  else if (command === "dry-run") await dryRun();
  else if (command === "check-cells") await checkCells(flags(rest));
  else if (command === "check-alarms") await checkAlarms(flags(rest));
  else if (command === "durability") await durability(flags(rest));
  else
    throw new Error(
      "usage: vps.mjs stage|deploy|dry-run|check-cells|check-alarms|check-heartbeats|alert-drill|durability|snapshot|ledger-record|ledger-verify|restore|drill|integration|lease|measure-heap|measure-write-delay|measure-guard [flags]",
    );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`vps: ${error.message}`);
    process.exit(1);
  });
}
