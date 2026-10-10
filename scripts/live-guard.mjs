#!/usr/bin/env node
// The live guard check on the test cell: runs the steps in scripts/live-guard-steps.mjs against
// the deployed test cell with the real `secbot` command line, and writes the evidence.
//
//   node scripts/live-guard.mjs preflight
//   node scripts/live-guard.mjs models --out <dir>
//   node scripts/live-guard.mjs charter --part 1|2 --out <dir> [--max-usd 5]
//   node scripts/live-guard.mjs report --out <dir>
//
// `models` sets every agent role that uses an Opus model to TEST_CELL_MODEL (Claude Sonnet 5.5)
// on the owner's test-cell person cell, makes sure its decision model is Jev, and writes the
// models to models-live.txt. The charter refuses to start while a role uses an Opus model or the
// decision model is not Jev. The test cell stays on these models after the run; no release
// default changes.
//
// It runs only after the owner's yes for the live calls (OpenRouter and Better Stack), from the
// owner's machine, through the test-cell runner that loads the owner's private settings. The cell
// address comes from SECBOT_CELL_URL, the device key from the owner's device file, and the
// operator key from SECBOT_OPERATOR_KEY or operator.json; preflight prints only SET or missing.
// Every evidence file is scrubbed in memory (each private value replaced by a placeholder) before
// it is written, then scanned with the repo's identifier check and a literal search; a hit fails
// the run and the file is not kept. The test secret and the broker token are random values made
// in memory and entered on standard input.
//
// Node standard library only.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scanText } from "./check-identifiers.mjs";
import {
  buildReport,
  CLEARING_FILES,
  CONTRACT,
  check,
  DEFAULT_MAX_USD,
  decisionModelOf,
  fillArgv,
  fixedLimit,
  isOpus,
  literalHits,
  MODEL_TURN_MS,
  modelsProblem,
  newestHeld,
  overSpend,
  parseModelList,
  placeLimit,
  STEPS,
  scrub,
  spendOf,
  stepsOf,
  TEST_CELL_DECISION_MODEL,
  TEST_CELL_MODEL,
} from "./live-guard-steps.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "packages", "cli", "src", "main.ts");
const POLL_MS = 250;
const OPEN_MS = 60_000;
const ANSWER_MS = 60_000;

/** The settings preflight names; each is reported as SET or missing, never shown. */
export const PREFLIGHT_VARS = [
  "SECBOT_CELL_URL",
  "SECBOT_VPS_SSH",
  "OPENROUTER_API_KEY",
  "BETTERSTACK_INCIDENTS_TOKEN",
  "BETTERSTACK_REQUESTER_EMAIL",
  "SECBOT_DEVICE_KEYS",
  "SECBOT_TIME_ZONE",
];

const configDir = (env, home) => env.SECBOT_CONFIG_DIR ?? join(home, ".config", "secbot");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Preflight lines: each setting SET or missing, the device file, the operator key, the optional
 * fake-target address, and whether the device key's hash is in SECBOT_DEVICE_KEYS for its person.
 * Never a value. `ok` is false when anything required is missing.
 */
/** The preflight labels, so every value starts in one column two spaces after the longest. */
const PREFLIGHT_LABELS = [
  ...PREFLIGHT_VARS,
  "device file",
  "operator key",
  "SECBOT_FAKE_TARGET_URL",
  "device key listed for its person",
];
export const PREFLIGHT_PAD = Math.max(...PREFLIGHT_LABELS.map((label) => label.length)) + 2;
const label = (text) => text.padEnd(PREFLIGHT_PAD);

/** A loopback host name, as the URL parser gives it (the secrets cell's broker rule). */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** True when the address is plain http on a host that is not loopback; the broker refuses it. */
export function plainHttpOffLoopback(address) {
  if (!URL.canParse(address)) return false;
  const url = new URL(address);
  return url.protocol === "http:" && !LOOPBACK.test(url.hostname);
}

export async function preflight(env = process.env, home = homedir()) {
  const lines = [];
  let ok = true;
  for (const name of PREFLIGHT_VARS) {
    const set = typeof env[name] === "string" && env[name] !== "";
    if (!set) ok = false;
    lines.push(`${label(name)}${set ? "SET" : "missing"}`);
  }
  const dir = configDir(env, home);
  const device = await readJson(join(dir, "device.json"));
  const deviceOk =
    typeof device?.name === "string" &&
    typeof device?.person === "string" &&
    typeof device?.key === "string";
  if (!deviceOk) ok = false;
  lines.push(`${label("device file")}${deviceOk ? "SET" : "missing"}`);
  const operator =
    (typeof env.SECBOT_OPERATOR_KEY === "string" && env.SECBOT_OPERATOR_KEY !== "") ||
    typeof (await readJson(join(dir, "operator.json")))?.key === "string";
  if (!operator) ok = false;
  lines.push(`${label("operator key")}${operator ? "SET" : "missing"}`);
  const fake = typeof env.SECBOT_FAKE_TARGET_URL === "string" && env.SECBOT_FAKE_TARGET_URL !== "";
  const cellUrl = env.SECBOT_CELL_URL ?? "";
  const target = fake
    ? env.SECBOT_FAKE_TARGET_URL
    : cellUrl === ""
      ? ""
      : `${cellUrl.replace(/\/+$/, "")}/fake-target`;
  if (plainHttpOffLoopback(target)) {
    ok = false;
    lines.push(
      `${label("SECBOT_FAKE_TARGET_URL")}refused: the secrets cell accepts plain http broker targets only on loopback; set SECBOT_FAKE_TARGET_URL to an https or loopback address`,
    );
  } else {
    lines.push(
      `${label("SECBOT_FAKE_TARGET_URL")}${fake ? "SET" : "not set (the cell address + /fake-target)"}`,
    );
  }
  if (deviceOk && typeof env.SECBOT_DEVICE_KEYS === "string") {
    const hash = createHash("sha256").update(device.key).digest("hex");
    const listed = env.SECBOT_DEVICE_KEYS.split(",")
      .map((entry) => entry.trim().split(":"))
      .some(([, person, sha]) => person === device.person && sha === hash);
    if (!listed) ok = false;
    lines.push(`${label("device key listed for its person")}${listed ? "yes" : "no"}`);
  }
  lines.push(ok ? "preflight: ready" : "preflight: not ready; place what is missing first");
  return { ok, lines };
}

/** The private values of the run, by placeholder name; none is ever written or printed. */
export async function privateValues(env = process.env, home = homedir(), made = {}) {
  const dir = configDir(env, home);
  const device = await readJson(join(dir, "device.json"));
  const operator = await readJson(join(dir, "operator.json"));
  const cellUrl = env.SECBOT_CELL_URL ?? "";
  const values = {
    "cell-url": cellUrl,
    "fake-target":
      env.SECBOT_FAKE_TARGET_URL ||
      (cellUrl === "" ? "" : `${cellUrl.replace(/\/+$/, "")}/fake-target`),
    "device-key": device?.key ?? "",
    "operator-key": env.SECBOT_OPERATOR_KEY || operator?.key || "",
    "vps-ssh": env.SECBOT_VPS_SSH ?? "",
    "openrouter-key": env.OPENROUTER_API_KEY ?? "",
    "incidents-token": env.BETTERSTACK_INCIDENTS_TOKEN ?? "",
    "requester-email": env.BETTERSTACK_REQUESTER_EMAIL ?? "",
    "device-keys": env.SECBOT_DEVICE_KEYS ?? "",
    ...made,
  };
  return { values, person: device?.person ?? "" };
}

/**
 * Writes one evidence file: scrubbed first, then scanned with the identifier check and a literal
 * search for every private value. A hit writes nothing and throws (naming the file and the rule,
 * never the value).
 */
export async function writeEvidence(dir, name, text, values) {
  const clean = scrub(text, values);
  const findings = scanText(name, clean);
  const hits = literalHits(clean, values);
  if (findings.length > 0 || hits.length > 0) {
    const what = [...findings.map((finding) => finding.rule), ...hits].join(", ");
    throw new Error(`evidence ${name} still holds a private value (${what}); not written`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), clean);
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Waits until `check` passes on the text `read` returns, or `ms` pass. */
async function waitFor(read, patterns, ms, deps) {
  const deadline = deps.now() + ms;
  for (;;) {
    const result = check(read(), patterns);
    if (result.missing.length === 0) return result;
    if (deps.now() > deadline) return result;
    await deps.sleep(POLL_MS);
  }
}

const describeMissing = (result) =>
  [
    ...result.missing.map((pattern) => `missing ${pattern.source}`),
    ...result.present.map((pattern) => `unexpected ${pattern.source}`),
  ].join("; ");

/**
 * Runs `steps` with `deps` (the live driver's processes, or the rehearsal's in-process stand-ins)
 * and returns `{ results, evidence }`: each step's `{ status, detail?, last? }` and the text of each
 * evidence file. A chat line the model never acted on leaves its step `not run`; a command whose
 * output differs leaves it `fail`. After every step the month's spend is read; a rise above
 * `maxUsd` stops the run, and the cleanup step still runs.
 *
 * deps: cli(argv, { stdin }) -> { code, out, err }; chat.open(), chat.send(line), chat.text(),
 * chat.close(), chat.isOpen(); sleep(ms); now(); scale (timeouts are multiplied by it).
 */
export async function executeSteps(steps, deps, context, state, maxUsd = DEFAULT_MAX_USD) {
  const results = {};
  const evidence = {};
  const add = (file, text) => {
    evidence[file] = `${evidence[file] ?? ""}${text}`;
  };
  let stopped;
  for (const step of steps) {
    if (stopped !== undefined && !step.cleanup) {
      results[step.id] = { status: "not run", detail: stopped };
      continue;
    }
    const { result, text } = await runStep(step, deps, context, state);
    results[step.id] = result;
    const part = `charter-part${step.part}.txt`;
    add(step.evidence, text);
    if (step.evidence !== part) add(part, text);
    const now = await spendNow(deps);
    if (stopped === undefined && overSpend(state.startSpend, now, maxUsd)) {
      stopped = `stopped: the month's spend rose by more than $${maxUsd}`;
    }
  }
  if (deps.chat.isOpen()) await deps.chat.close();
  return { results, evidence };
}

const spendNow = async (deps) => spendOf((await deps.cli(["cost"], {})).out)?.spend;

/** The role-to-model map and the decision model of `person`'s cell, read with `deps.cli`. */
async function readModels(deps, person, run = deps.cli) {
  const list = await run(["model", "list"], {});
  const shown = await run(["mode", "show", person], {});
  return {
    roles: list.code === 0 ? parseModelList(list.out) : [],
    decisionModel: shown.code === 0 ? decisionModelOf(shown.out) : undefined,
  };
}

/** Why the charter may not start on `person`'s current models, or undefined when it may. */
export async function checkModels(deps, person) {
  const { roles, decisionModel } = await readModels(deps, person);
  return modelsProblem(roles, decisionModel);
}

/**
 * The test cell's models for a live check: every role on an Opus model moves to TEST_CELL_MODEL,
 * and the decision model to Jev when it is another. Roles on other models are not touched, so a
 * second run changes nothing. Returns the transcript and the problem that remains, if any.
 */
export async function setTestModels(deps, person) {
  const chunk = ["## models"];
  const run = async (argv) => {
    const result = await deps.cli(argv, {});
    const err = result.err ? `[stderr]\n${result.err}` : "";
    chunk.push(`$ secbot ${argv.join(" ")}`, `${result.out}${err}[exit ${result.code}]`);
    return result;
  };
  const before = await readModels(deps, person, run);
  for (const { role, model } of before.roles) {
    if (isOpus(model)) await run(["model", "set", role, TEST_CELL_MODEL]);
  }
  if (before.decisionModel !== TEST_CELL_DECISION_MODEL) {
    await run(["mode", "decision", person, TEST_CELL_DECISION_MODEL]);
  }
  const after = await readModels(deps, person, run);
  const problem = modelsProblem(after.roles, after.decisionModel);
  chunk.push(`[models: ${problem === undefined ? "pass" : `fail: ${problem}`}]`);
  return { problem, text: `${chunk.join("\n")}\n` };
}

/** One step: its actions in order, until one fails. Returns its result and its transcript. */
async function runStep(step, deps, context, state) {
  const scale = deps.scale ?? 1;
  const chunk = [`## ${step.id}`];
  let answerMark;

  const cmd = async (argv, stdin) => {
    const result = await deps.cli(fillArgv(argv, context), stdin === undefined ? {} : { stdin });
    const err = result.err ? `[stderr]\n${result.err}` : "";
    chunk.push(`$ secbot ${argv.join(" ")}`, `${result.out}${err}[exit ${result.code}]`);
    return result;
  };

  const chatTurn = async (line, patterns, ms) => {
    const mark = deps.chat.text().length;
    chunk.push(`> ${line}`);
    await deps.chat.send(line);
    const since = () => deps.chat.text().slice(mark);
    const result = await waitFor(since, patterns, ms * scale, deps);
    chunk.push(since().replace(/\n+$/, ""));
    return { result, text: since() };
  };

  const commandAction = async (action, patterns) => {
    const stdin = action.kind === "stdin" ? context.values[action.value] : undefined;
    // A live model's tool call can land after its chat turn printed: a command with `waitMs`
    // runs again every 5 s until its patterns match or the wait ends.
    const deadline = deps.now() + (action.waitMs ?? 0) * scale;
    let result = await cmd(action.argv, stdin);
    let found = check(`${result.out}${result.err}`, patterns);
    while (
      action.waitMs !== undefined &&
      !(result.code === 0 && found.missing.length === 0 && found.present.length === 0) &&
      deps.now() < deadline
    ) {
      await deps.sleep(5_000 * scale);
      result = await cmd(action.argv, stdin);
      found = check(`${result.out}${result.err}`, patterns);
    }
    if (result.code === 0 && found.missing.length === 0 && found.present.length === 0) {
      return { ok: true };
    }
    const detail = result.code !== 0 ? `exit ${result.code}` : describeMissing(found);
    return { ok: false, detail, text: `${result.out}${result.err}` };
  };

  const openAction = async (patterns) => {
    const mark = deps.chat.text().length;
    chunk.push("$ secbot chat");
    await deps.chat.open();
    const since = () => deps.chat.text().slice(mark);
    const found = await waitFor(since, patterns, OPEN_MS * scale, deps);
    chunk.push(since().replace(/\n+$/, ""));
    answerMark = undefined;
    if (found.missing.length === 0) return { ok: true };
    return { ok: false, detail: describeMissing(found), text: since() };
  };

  const chatAction = async (action, patterns) => {
    if (!deps.chat.isOpen()) {
      chunk.push("$ secbot chat");
      await deps.chat.open();
    }
    const ms = action.timeoutMs ?? MODEL_TURN_MS;
    const start = deps.chat.text().length;
    const since = () => deps.chat.text().slice(start);
    const seen = () => check(since(), patterns).missing.length === 0;
    // A repeated line waits for each turn's usage line, then checks the whole action's output.
    const perTurn = action.repeat === undefined ? patterns : { expect: [CONTRACT.usage] };
    for (let sent = 0; sent < (action.repeat ?? 1) && !seen(); sent++) {
      await chatTurn(action.say, perTurn, ms);
    }
    for (const line of action.plainer ?? []) {
      if (seen()) break;
      await chatTurn(line, patterns, ms);
    }
    if (action.keep === "pending") state.pendingHeld = newestHeld(since());
    const found = check(since(), patterns);
    if (found.missing.length > 0) {
      const detail = `the model did not: ${describeMissing(found)}`;
      return { ok: false, notRun: true, detail, text: since() };
    }
    if (found.present.length > 0)
      return { ok: false, detail: describeMissing(found), text: since() };
    return { ok: true };
  };

  const answerAction = async (action, patterns) => {
    const number = action.from === "pending" ? state.pendingHeld : newestHeld(deps.chat.text());
    if (number === undefined) return { ok: false, notRun: true, detail: "no held call to answer" };
    answerMark = deps.chat.text().length;
    const ms = action.timeoutMs ?? ANSWER_MS;
    const turn = await chatTurn(`/${action.choice} ${number}`, patterns, ms);
    if (turn.result.missing.length === 0) return { ok: true };
    return { ok: false, detail: describeMissing(turn.result), text: turn.text };
  };

  const limitAction = async (action, patterns) => {
    let value;
    if (action.to === "restore") {
      value = fixedLimit("restore", { original: state.originalLimit });
    } else {
      const now = await spendNow(deps);
      if (now === undefined) return { ok: false, detail: "no spend in secbot cost" };
      value =
        action.to === "test" ? fixedLimit("test", { spendUsd: now }) : placeLimit(now, action.to);
      if (value === undefined) {
        chunk.push(`(the $1.00 test limit is skipped: the spend is already at 75% of it)`);
        return { ok: true };
      }
    }
    const result = await cmd(["limits", "set", "{person}", value]);
    const found = check(`${result.out}${result.err}`, patterns);
    if (result.code === 0 && found.missing.length === 0) return { ok: true };
    const detail = describeMissing(found) || `exit ${result.code}`;
    return { ok: false, detail, text: `${result.out}${result.err}` };
  };

  const closeAction = async (patterns) => {
    const since = deps.chat.text().slice(answerMark ?? 0);
    await deps.chat.close();
    chunk.push("(chat closed)");
    const found = check(since, patterns);
    if (found.present.length === 0) return { ok: true };
    return { ok: false, detail: describeMissing(found), text: since };
  };

  const runAction = async (action) => {
    const patterns = { expect: action.expect ?? [], reject: action.reject ?? [] };
    if (action.kind === "cmd" || action.kind === "stdin") return commandAction(action, patterns);
    if (action.kind === "open") return openAction(patterns);
    if (action.kind === "chat") return chatAction(action, patterns);
    if (action.kind === "answer") return answerAction(action, patterns);
    if (action.kind === "limit") return limitAction(action, patterns);
    if (action.kind === "close") return closeAction(patterns);
    if (action.kind === "pause") {
      await deps.sleep(action.ms * scale);
      return { ok: true };
    }
    return { ok: false, detail: `unknown action ${action.kind}` };
  };

  let result = { status: "pass" };
  for (const action of step.actions) {
    const outcome = await runAction(action);
    if (outcome.ok || action.optional) continue;
    result = {
      status: outcome.notRun ? "not run" : "fail",
      detail: outcome.detail,
      ...(outcome.text === undefined ? {} : { last: outcome.text }),
    };
    break;
  }
  const tail = `[${step.id}: ${result.status}${result.detail ? `: ${result.detail}` : ""}]`;
  return { result, text: `${chunk.join("\n")}\n${tail}\n\n` };
}

// ---- the live processes ------------------------------------------------------------------------

/** One `secbot` run as a child process; a value for standard input is written, never echoed. */
export function cliProcess(env = process.env) {
  return (argv, { stdin } = {}) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", CLI, ...argv], {
        cwd: root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        err += chunk;
      });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("error", fail);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, out, err });
      });
      child.stdin.end(stdin === undefined ? "" : `${stdin}\n`);
    });
}

/** `secbot chat` as a child process with piped input and output. */
export function chatProcess(env = process.env) {
  let child;
  let text = "";
  return {
    isOpen: () => child !== undefined,
    text: () => text,
    async open() {
      child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", CLI, "chat"], {
        cwd: root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        text += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        text += chunk;
      });
      child.on("close", () => {
        child = undefined;
      });
    },
    async send(line) {
      child?.stdin.write(`${line}\n`);
    },
    async close() {
      const current = child;
      if (current === undefined) return;
      current.stdin.end();
      const deadline = Date.now() + 20_000;
      while (child !== undefined && Date.now() < deadline) await pause(100);
      if (child !== undefined) current.kill();
      child = undefined;
    },
  };
}

const liveDeps = () => ({
  cli: cliProcess(),
  chat: chatProcess(),
  sleep: pause,
  now: () => Date.now(),
});

/** The models step against the live test cell: writes models-live.txt. Returns the exit code. */
export async function models({ out }) {
  if (!out) throw new Error("models needs --out <dir>");
  const ready = await preflight();
  if (!ready.ok) {
    console.log(ready.lines.join("\n"));
    return 1;
  }
  const { values, person } = await privateValues();
  const { problem, text } = await setTestModels(liveDeps(), person);
  await writeEvidence(out, "models-live.txt", text, values);
  console.log(scrub(text, values));
  return problem === undefined ? 0 : 1;
}

async function readState(out) {
  return (await readJson(join(out, "state.json"))) ?? {};
}

/** One part of the charter run against the live test cell. Returns the exit code. */
export async function charter({ part, out, "max-usd": maxUsd = String(DEFAULT_MAX_USD) }) {
  if (part !== "1" && part !== "2") throw new Error("charter needs --part 1|2");
  if (!out) throw new Error("charter needs --out <dir>");
  const ready = await preflight();
  if (!ready.ok) {
    console.log(ready.lines.join("\n"));
    return 1;
  }
  const made = {
    "test-secret": `lt-${randomBytes(12).toString("hex")}`,
    "broker-token": `lb-${randomBytes(16).toString("hex")}`,
  };
  const { values, person } = await privateValues(process.env, homedir(), made);
  const context = {
    person,
    fakeTarget: values["fake-target"],
    values: { ...values, testSecret: made["test-secret"], brokerToken: made["broker-token"] },
  };
  const deps = liveDeps();
  // The owner's choice for live checks: no Opus role and Jev as the decision model.
  const refused = await checkModels(deps, person);
  if (refused !== undefined) {
    console.log(refused);
    return 1;
  }
  const state = part === "1" ? {} : await readState(out);
  if (part === "1") {
    const found = spendOf((await deps.cli(["cost"], {})).out);
    state.startSpend = found?.spend;
    state.originalLimit = found?.limit;
  }
  const steps = part === "1" ? stepsOf(1) : [...stepsOf(2)];
  const { results, evidence } = await executeSteps(steps, deps, context, state, Number(maxUsd));
  const scrubValues = context.values;
  // A stop in part 1 still restores the limit and the rules.
  if (part === "1" && Object.values(results).some((r) => (r.detail ?? "").startsWith("stopped"))) {
    const cleanup = await executeSteps(
      stepsOf(2).filter((s) => s.cleanup),
      deps,
      context,
      state,
    );
    Object.assign(results, cleanup.results);
    for (const [file, text] of Object.entries(cleanup.evidence)) evidence[file] = text;
  }
  for (const [file, text] of Object.entries(evidence)) {
    await writeEvidence(out, file, text, scrubValues);
  }
  const safeResults = JSON.parse(scrub(JSON.stringify(results), scrubValues));
  await writeEvidence(
    out,
    `results-part${part}.json`,
    `${JSON.stringify(safeResults, null, 2)}\n`,
    scrubValues,
  );
  await writeFile(
    join(out, "state.json"),
    `${JSON.stringify({ startSpend: state.startSpend, originalLimit: state.originalLimit, pendingHeld: state.pendingHeld }, null, 2)}\n`,
  );
  const report = buildReport(safeResults, steps);
  console.log(report);
  return Object.values(safeResults).every((result) => result.status === "pass") ? 0 : 1;
}

/** summary.md from both parts' results, with the clearing files present or missing. */
export async function report({ out }) {
  if (!out) throw new Error("report needs --out <dir>");
  const results = {
    ...((await readJson(join(out, "results-part1.json"))) ?? {}),
    ...((await readJson(join(out, "results-part2.json"))) ?? {}),
  };
  const lines = [buildReport(results, STEPS), "CLEARING FILES"];
  for (const file of CLEARING_FILES) {
    lines.push(`${file.padEnd(28)}${existsSync(join(out, file)) ? "present" : "missing"}`);
  }
  const text = `${lines.join("\n")}\n`;
  await writeEvidence(out, "summary.md", text, {});
  console.log(text);
  return Object.values(results).every((result) => result.status === "pass") &&
    CLEARING_FILES.every((file) => existsSync(join(out, file)))
    ? 0
    : 1;
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { part: { type: "string" }, out: { type: "string" }, "max-usd": { type: "string" } },
    allowPositionals: true,
  });
  if (command === "preflight") {
    const ready = await preflight();
    console.log(ready.lines.join("\n"));
    return ready.ok ? 0 : 1;
  }
  if (command === "models") return models(values);
  if (command === "charter") return charter(values);
  if (command === "report") return report(values);
  console.error(
    "usage: live-guard.mjs preflight | models --out <dir> | charter --part 1|2 --out <dir> [--max-usd 5] | report --out <dir>",
  );
  return 2;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`live-guard: ${error.message}`);
      process.exit(1);
    },
  );
}
