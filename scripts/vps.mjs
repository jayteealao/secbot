#!/usr/bin/env node
// Client for the VPS release tool (infra/ansible/roles/deploy_users/files/secbot-release).
// Node standard library only: deploy and check jobs run without node_modules.
//
//   node scripts/vps.mjs stage   --version V --sha256 S --file F
//   node scripts/vps.mjs deploy  --env test-cell|production --version V [--sha256 S] [--cells C]
//   node scripts/vps.mjs dry-run
//   node scripts/vps.mjs check-cells --env test-cell|production [--version V] [--cells owner,second]
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

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "stage") await stage(flags(rest));
  else if (command === "deploy") await deploy(flags(rest));
  else if (command === "dry-run") await dryRun();
  else if (command === "check-cells") await checkCells(flags(rest));
  else throw new Error("usage: vps.mjs stage|deploy|dry-run|check-cells [flags]");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`vps: ${error.message}`);
    process.exit(1);
  });
}
