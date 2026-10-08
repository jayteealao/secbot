#!/usr/bin/env node
// mise run test:conformance — pi-durable's storage conformance suite inside a real celld cell.
//
//   --target test-cell  the test cell on the VPS (the evidence for a release); default when
//                       SECBOT_VPS_SSH is set or in GitHub Actions
//   --target local      `celld dev` on this machine (Linux or macOS); default when celld is on PATH
//   --long-transaction  also hold one transaction past celld's 30-second limit and check that
//                       the driver reports a timeout and no marker row is visible afterwards
//   --version V         test-cell only: the staged bundle to test (default: the release tag in
//                       CI, else a fresh dev build that this command stages)
//
// Output phrases match docs/runbooks/conformance-fail.md.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runRemote, stage } from "./vps.mjs";

export const EXPECTED_ADAPTER = "CelldSqliteDatabase";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Prints the result lines and returns the number of problems (0 means pass). */
export function reportSuite(report, log = console.log) {
  let problems = 0;
  for (const result of report.cases ?? []) {
    if (!result.ok) log(`conformance case fail: ${result.name}: ${result.error}`);
  }
  const failed = report.failed ?? 0;
  log(`storage conformance suite: ${report.passed ?? 0} passed, ${failed} failed`);
  problems += failed;
  if ((report.cases ?? []).length === 0) {
    log("storage conformance suite: FAIL, no case ran");
    problems += 1;
  }
  if (report.adapter !== EXPECTED_ADAPTER) {
    log(`adapter mismatch: ${report.adapter} ran, expected ${EXPECTED_ADAPTER}`);
    problems += 1;
  }
  return problems;
}

/** Checks the long-transaction result: a reported timeout and no visible marker row. */
export function reportLongTransaction(result, log = console.log) {
  const first = result.longTransaction ?? {};
  const visible = result.after?.markerRowsVisible;
  log(
    `long transaction: timedOut=${first.timedOut === true} durationMs=${first.durationMs ?? "?"} markerRowsVisible=${visible}`,
  );
  let problems = 0;
  if (first.timedOut !== true) {
    log(
      `conformance case fail: long transaction: the driver did not report a timeout (${first.error ?? "no error"})`,
    );
    problems += 1;
  }
  if (visible !== 0) {
    log(
      `conformance case fail: long transaction: ${visible} marker row(s) visible after the reset`,
    );
    problems += 1;
  }
  return problems;
}

export function chooseTarget(requested, env = process.env, hasCelld = () => onPath("celld")) {
  if (requested) {
    if (requested !== "test-cell" && requested !== "local")
      throw new Error(`unknown target "${requested}"`);
    return requested;
  }
  if (env.SECBOT_VPS_SSH || env.GITHUB_ACTIONS === "true") return "test-cell";
  if (hasCelld()) return "local";
  throw new Error(
    "no celld to test against: set SECBOT_VPS_SSH to reach the test cell, or install celld (Linux or macOS) for --target local",
  );
}

function onPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

const buildBundle = (version) =>
  execFileSync(
    process.execPath,
    [join(root, "scripts", "build-bundle.mjs"), "--version", version],
    {
      stdio: "inherit",
    },
  );

async function stageDevBuild() {
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const version = `0.0.0-dev.${sha}`;
  buildBundle(version);
  const file = join(root, `secbot-${version}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", join(root, "dist"), "."], { stdio: "inherit" });
  const sha256 = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  await stage({ version, sha256, file });
  return version;
}

async function runOnTestCell({ version, longTransaction }) {
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  const target = version ?? tag ?? (await stageDevBuild());
  console.log(
    `storage conformance suite: running ${target} in the test cell (each write waits for the bucket; this is slow)`,
  );
  const words = ["conformance", "--version", target];
  const suite = JSON.parse(await runRemote(words));
  let problems = reportSuite(suite);
  if (longTransaction) {
    problems += reportLongTransaction(
      JSON.parse(await runRemote([...words, "--long-transaction"])),
    );
  }
  return problems;
}

async function waitForHealth(base, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`celld dev exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("celld dev did not answer /health within 60 seconds");
}

async function runLocal({ longTransaction }) {
  if (process.platform === "win32")
    throw new Error("celld does not run on Windows; use --target test-cell");
  buildBundle("0.0.0-dev");
  const port = process.env.PORT ?? "9876";
  const base = `http://127.0.0.1:${port}`;
  const child = spawn("celld", ["dev", "--clean", "--port", port], {
    cwd: join(root, "dist", "conformance"),
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    await waitForHealth(base, child);
    const suite = await (await fetch(`${base}/conformance/run`, { method: "POST" })).json();
    let problems = reportSuite(suite);
    if (longTransaction) {
      const first = await fetch(`${base}/conformance/long-transaction?ms=31000`, { method: "POST" })
        .then((response) => response.json())
        .catch((error) => ({ error: String(error) }));
      const after = await (await fetch(`${base}/conformance/marker`)).json();
      problems += reportLongTransaction({ longTransaction: first, after });
    }
    return problems;
  } finally {
    child.kill("SIGTERM");
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      version: { type: "string" },
      "long-transaction": { type: "boolean", default: false },
    },
  });
  const target = chooseTarget(values.target);
  const options = { version: values.version, longTransaction: values["long-transaction"] };
  const problems = target === "test-cell" ? await runOnTestCell(options) : await runLocal(options);
  if (problems > 0) {
    console.log(`storage conformance suite: FAIL (${problems} problem(s))`);
    process.exit(1);
  }
  console.log("storage conformance suite: PASS");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(`storage conformance suite: FAIL: ${error.message}`);
    process.exit(1);
  });
}
