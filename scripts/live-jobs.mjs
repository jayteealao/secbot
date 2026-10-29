#!/usr/bin/env node
// The live jobs check on the test cell: runs the steps in scripts/live-jobs-steps.mjs against the
// deployed test cell with the real `secbot` command line, as the owner, the second person, and
// the operator, and writes the evidence.
//
//   node scripts/live-jobs.mjs preflight
//   node scripts/live-jobs.mjs models --out <dir>
//   node scripts/live-jobs.mjs charter --out <dir> [--max-usd 10]
//   node scripts/live-jobs.mjs stop-all --out <dir> [--max-usd 10]
//   node scripts/live-jobs.mjs capacity-line --out <dir> --measured-from <capacity.json>
//   node scripts/live-jobs.mjs signals --since <epoch-s> --out <dir> [--until <epoch-s>]
//   node scripts/live-jobs.mjs report --out <dir>
//
// `models` is the live guard check's: no Opus role and Jev as the decision model, written to
// models-live.txt; the charter and the stop refuse to start otherwise. `capacity-line` sets the
// owner's measured number one below the jobs it then starts, shows the board's capacity line,
// waits for the owner to type whether the alert arrived, and sets the measured number back to the
// one in capacity.json (or clears it). `signals` counts each job signal per cell in the test
// cell's logs through the test-cell runner's count mode.
//
// It runs only after the owner's yes for the live calls (OpenRouter and Better Stack), from the
// owner's machine, through the test-cell runner that loads the owner's private settings. The
// owner's device file comes from SECBOT_CONFIG_DIR, the second person's from
// SECBOT_SECOND_CONFIG_DIR, and the operator key from SECBOT_OPERATOR_KEY or operator.json;
// preflight prints only SET or missing. Every evidence file is scrubbed in memory before it is
// written, then scanned with the repo's identifier check and a literal search; a hit fails the run
// and the file is not kept.
//
// Node standard library only.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  chatProcess,
  checkModels,
  cliProcess,
  executeSteps,
  preflight as guardPreflight,
  privateValues as guardPrivateValues,
  PREFLIGHT_PAD,
  setTestModels,
  writeEvidence,
} from "./live-guard.mjs";
import { scrub, spendOf } from "./live-guard-steps.mjs";
import { buildReport, DEFAULT_MAX_USD, STEPS, stepsOf } from "./live-jobs-steps.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The person the second device file must name. */
export const SECOND_PERSON = "second";

const label = (text) => text.padEnd(PREFLIGHT_PAD);

/** The second person's device file, when SECBOT_SECOND_CONFIG_DIR names a folder holding one. */
async function secondDevice(env) {
  const dir = env.SECBOT_SECOND_CONFIG_DIR;
  if (typeof dir !== "string" || dir === "") return undefined;
  const device = await readJson(join(dir, "device.json"));
  return typeof device?.name === "string" &&
    typeof device?.person === "string" &&
    typeof device?.key === "string"
    ? device
    : undefined;
}

/**
 * Preflight lines: the live guard check's (each setting, the owner's device file, the operator
 * key), then the second person's device file (its person must be `second`) and whether its key's
 * hash is listed for that person. Each is SET or missing, never a value. `ok` is false when
 * anything required is missing.
 */
export async function preflight(env = process.env, home = homedir()) {
  const guard = await guardPreflight(env, home);
  let ok = guard.ok;
  const lines = guard.lines.slice(0, -1);
  const device = await secondDevice(env);
  const second = device?.person === SECOND_PERSON;
  if (!second) ok = false;
  lines.push(`${label("SECBOT_SECOND_CONFIG_DIR")}${second ? "SET" : "missing"}`);
  if (second && typeof env.SECBOT_DEVICE_KEYS === "string") {
    const hash = createHash("sha256").update(device.key).digest("hex");
    const listed = env.SECBOT_DEVICE_KEYS.split(",")
      .map((entry) => entry.trim().split(":"))
      .some(([, person, sha]) => person === SECOND_PERSON && sha === hash);
    if (!listed) ok = false;
    lines.push(`${label("second device key listed")}${listed ? "yes" : "no"}`);
  }
  lines.push(ok ? "preflight: ready" : "preflight: not ready; place what is missing first");
  return { ok, lines };
}

/** The run's private values, by placeholder name: the guard check's and the second device key. */
export async function privateValues(env = process.env, home = homedir(), made = {}) {
  const { values, person } = await guardPrivateValues(env, home, made);
  const device = await secondDevice(env);
  return { values: { ...values, "second-device-key": device?.key ?? "" }, person };
}

/** The job signals the run counts, per cell, in the test cell's logs. */
export const LIVE_SIGNALS = [
  "job.started",
  "job.finished",
  "job.result_waiting",
  "job.result_pulled",
  "job.paused",
  "job.raised",
  "job.restarted",
  "job.injection_stop",
  "job.stopped",
  "input.steered",
  "stop.left_running",
  "capacity.passed",
];
/** The cells the run touches. */
export const LIVE_CELLS = ["owner", SECOND_PERSON, "household"];

const USAGE = [
  "usage: live-jobs.mjs preflight",
  "  | models --out <dir>",
  "  | charter --out <dir> [--max-usd 10]",
  "  | stop-all --out <dir> [--max-usd 10]",
  "  | capacity-line --out <dir> --measured-from <capacity.json>",
  "  | signals --since <epoch-s> --out <dir> [--until <epoch-s>]",
  "  | report --out <dir>",
].join("\n");

const EPOCH_S = /^\d{9,11}$/;

/**
 * Why a command's arguments are refused, or undefined when they are complete. Every command but
 * preflight needs --out; --max-usd is a positive number up to 50; capacity-line needs
 * --measured-from; signals needs --since (and an optional --until after it) in epoch seconds. Pure.
 */
export function argumentProblem(command, values) {
  const commands = ["models", "charter", "stop-all", "capacity-line", "signals", "report"];
  if (command === "preflight") return undefined;
  if (!commands.includes(command)) return USAGE;
  if (!values.out) return `${command} needs --out <dir>`;
  if (values["max-usd"] !== undefined) {
    const usd = Number(values["max-usd"]);
    if (!(command === "charter" || command === "stop-all")) {
      return `${command} takes no --max-usd`;
    }
    if (!(Number.isFinite(usd) && usd > 0 && usd <= 50)) return "--max-usd is a number 0-50";
  }
  if (command === "capacity-line" && !values["measured-from"]) {
    return "capacity-line needs --measured-from <capacity.json>";
  }
  if (command === "signals") {
    if (!EPOCH_S.test(values.since ?? "")) return "signals needs --since <epoch seconds>";
    if (values.until !== undefined) {
      if (!EPOCH_S.test(values.until)) return "--until is epoch seconds";
      if (Number(values.until) <= Number(values.since)) return "--until comes after --since";
    }
  }
  return undefined;
}

/**
 * The measured number to put back after the capacity line: the one capacity.json holds, with its
 * day as midnight UTC, or null (cleared) when the file holds none. Pure.
 */
export function measuredBack(file) {
  const measured = file?.measured;
  const at = Date.parse(`${file?.on ?? ""}T00:00:00Z`);
  return Number.isInteger(measured) && measured >= 1 && Number.isFinite(at)
    ? { measured, at }
    : { measured: null, at: null };
}

/** The signals file: one line per signal with its count in each cell, and the window. Pure. */
export function signalLines(counts, since, until) {
  const lines = [
    `SIGNALS  ${since} to ${until} (epoch seconds)`,
    `${"SIGNAL".padEnd(22)}${LIVE_CELLS.map((cell) => cell.padEnd(11)).join("")}`.trimEnd(),
  ];
  for (const name of LIVE_SIGNALS) {
    const row = LIVE_CELLS.map((cell) => String(counts[name]?.[cell] ?? "?").padEnd(11)).join("");
    lines.push(`${name.padEnd(22)}${row}`.trimEnd());
  }
  return lines;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The live runners: the owner's (also the operator's), and the second person's own. */
function liveDeps(env = process.env) {
  const second = { configDir: env.SECBOT_SECOND_CONFIG_DIR };
  return {
    cli: cliProcess(env),
    chat: chatProcess(env),
    cliAs: { second: cliProcess(env, second) },
    chatAs: { second: chatProcess(env, second) },
    sleep: pause,
    now: () => Date.now(),
  };
}

/** Preflight, printed and refused when not ready. */
async function ready() {
  const checked = await preflight();
  if (!checked.ok) console.log(checked.lines.join("\n"));
  return checked.ok;
}

/** The models step against the live test cell: writes models-live.txt. */
export async function models({ out }) {
  if (!(await ready())) return 1;
  const { values, person } = await privateValues();
  const { problem, text } = await setTestModels(liveDeps(), person);
  await writeEvidence(out, "models-live.txt", text, values);
  console.log(scrub(text, values));
  return problem === undefined ? 0 : 1;
}

/** Runs one group of steps against the live test cell and writes their evidence and results. */
async function runGroup(group, { out, "max-usd": maxUsd = String(DEFAULT_MAX_USD) }, before) {
  if (!(await ready())) return 1;
  const { values, person } = await privateValues();
  const deps = liveDeps();
  // The owner's choice for live checks: no Opus role and Jev as the decision model.
  const refused = await checkModels(deps, person);
  if (refused !== undefined) {
    console.log(refused);
    return 1;
  }
  const state = { startSpend: spendOf((await deps.cli(["cost"], {})).out)?.spend };
  const context = { person, values };
  await before?.(deps, values);
  const steps = stepsOf(group);
  const { results, evidence } = await executeSteps(steps, deps, context, state, Number(maxUsd));
  for (const [file, text] of Object.entries(evidence)) {
    await writeEvidence(out, file, text, values);
  }
  const safe = JSON.parse(scrub(JSON.stringify(results), values));
  await writeEvidence(out, `results-${group}.json`, `${JSON.stringify(safe, null, 2)}\n`, values);
  console.log(buildReport(safe, steps));
  return Object.values(safe).every((result) => result.status === "pass") ? 0 : 1;
}

/** `PUT /ops/capacity?cell=owner` with the operator key. Returns the status. */
async function putCapacity(values, person, body) {
  const base = values["cell-url"].replace(/\/+$/, "");
  const answer = await fetch(`${base}/ops/capacity?cell=${encodeURIComponent(person)}`, {
    method: "PUT",
    headers: { "x-secbot-operator": values["operator-key"], "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answer.status;
}

/** Asks the owner one yes-or-no question on the terminal. */
async function askOwner(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `)).trim());
  } finally {
    terminal.close();
  }
}

/**
 * The capacity line: the owner's measured number set to 1, two slow jobs started, the board's
 * capacity line shown, the owner's word on the alert, then the measured number from capacity.json
 * put back (or cleared). The number goes back even when a step fails.
 */
export async function capacityLine({ out, "measured-from": from }) {
  if (!(await ready())) return 1;
  const file = await readJson(from);
  if (file === undefined) throw new Error("capacity-line: the --measured-from file is not JSON");
  const { values, person } = await privateValues();
  const deps = liveDeps();
  const lines = ["## capacity setup"];
  const at = Date.now();
  const set = await putCapacity(values, person, { measured: 1, at });
  lines.push(`PUT /ops/capacity measured 1: ${set}`);
  // A number that was not set would make the check pass or fail for the wrong reason.
  if (set < 200 || set > 299) {
    console.error(`capacity-line: setting the number failed (${set}); no job started`);
    return 1;
  }
  let code = 1;
  try {
    const start = await executeSteps(
      STEPS.filter((step) => step.id === "c6").map((step) => ({
        ...step,
        id: "k0",
        evidence: "capacity-line.txt",
        actions: step.actions.slice(0, 3),
      })),
      deps,
      { person, values },
      {},
    );
    const line = await executeSteps(stepsOf("capacity-line"), deps, { person, values }, {});
    const alert = await askOwner("Did the owner's capacity alert arrive in Better Stack?");
    lines.push(`owner confirmed the alert arrived: ${alert ? "yes" : "no"}`);
    const text = `${start.evidence["capacity-line.txt"] ?? ""}${line.evidence["capacity-line.txt"] ?? ""}`;
    await writeEvidence(out, "capacity-line.txt", `${lines.join("\n")}\n${text}`, values);
    const results = { ...line.results, alert: { status: alert ? "pass" : "fail" } };
    await writeEvidence(
      out,
      "results-capacity-line.json",
      `${JSON.stringify(JSON.parse(scrub(JSON.stringify(results), values)), null, 2)}\n`,
      values,
    );
    code = Object.values(results).every((result) => result.status === "pass") ? 0 : 1;
  } finally {
    const back = measuredBack(file);
    try {
      const status = await putCapacity(values, person, back);
      console.log(`capacity set back to ${back.measured ?? "none"}: ${status}`);
      if (status < 200 || status > 299) throw new Error(`status ${status}`);
    } catch (error) {
      code = 1;
      console.error(
        `capacity NOT restored (${error instanceof Error ? error.message : String(error)}); run the PUT by hand`,
      );
    }
    // The slow jobs started for the check stop whatever the set-back did.
    await deps.cli(["stop"], {});
  }
  return code;
}

/** One count through the test-cell runner's count mode; undefined when it gave no number. */
function countOf(event, cell, since, until) {
  return new Promise((done) => {
    const child = spawn("bash", [".scratch/tc.sh", "count", event, cell, since, until], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => done(undefined));
    child.on("close", () => {
      const found = /^(\d+)\s*$/m.exec(out);
      done(found === null ? undefined : Number(found[1]));
    });
  });
}

/** signals.txt: each job signal counted per cell over the run's window. */
export async function signals({ out, since, until = String(Math.floor(Date.now() / 1000)) }) {
  const counts = {};
  for (const name of LIVE_SIGNALS) {
    counts[name] = {};
    for (const cell of LIVE_CELLS) counts[name][cell] = await countOf(name, cell, since, until);
  }
  const text = `${signalLines(counts, since, until).join("\n")}\n`;
  const { values } = await privateValues();
  await writeEvidence(out, "signals.txt", text, values);
  console.log(text);
  // A count the runner could not give is not evidence: the run fails instead of looking complete.
  const all = Object.values(counts).flatMap((byCell) => Object.values(byCell));
  const missed = all.filter((count) => count === undefined).length;
  if (missed > 0) {
    console.error(
      `signals: could not count ${missed} of ${all.length} (is .scratch/tc.sh present?)`,
    );
    return 1;
  }
  return 0;
}

/** An evidence file is present when it exists; signals.txt also needs every count (no `?`). */
async function evidencePresent(out, file) {
  if (!existsSync(join(out, file))) return false;
  return file !== "signals.txt" || !(await readFile(join(out, file), "utf8")).includes("?");
}

/** summary.md: every group's results, one line per step and per criterion. */
export async function report({ out }) {
  const results = {};
  for (const group of ["charter", "stop-all", "capacity-line"]) {
    Object.assign(results, (await readJson(join(out, `results-${group}.json`))) ?? {});
  }
  const files = ["models-live.txt", ...new Set(STEPS.map((step) => step.evidence)), "signals.txt"];
  const lines = [buildReport(results, STEPS).trimEnd(), "", "EVIDENCE FILES"];
  const present = {};
  for (const file of files) {
    present[file] = await evidencePresent(out, file);
    lines.push(`${file.padEnd(28)}${present[file] ? "present" : "missing"}`);
  }
  const alert = results.alert?.status ?? "not run";
  lines.push("", `${"capacity alert".padEnd(21)}${alert}`);
  const text = `${lines.join("\n")}\n`;
  await writeEvidence(out, "summary.md", text, {});
  console.log(text);
  const passed = STEPS.every((step) => results[step.id]?.status === "pass") && alert === "pass";
  return passed && files.every((file) => present[file]) ? 0 : 1;
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      "max-usd": { type: "string" },
      "measured-from": { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
    },
    allowPositionals: true,
  });
  const problem = argumentProblem(command, values);
  if (problem !== undefined) {
    console.error(problem);
    return 2;
  }
  if (command === "preflight") {
    const checked = await preflight();
    console.log(checked.lines.join("\n"));
    return checked.ok ? 0 : 1;
  }
  if (command === "models") return models(values);
  if (command === "charter") return runGroup("charter", values);
  if (command === "stop-all") return runGroup("stop-all", values);
  if (command === "capacity-line") return capacityLine(values);
  if (command === "signals") return signals(values);
  return report(values);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`live-jobs: ${error.message}`);
      process.exit(1);
    },
  );
}
