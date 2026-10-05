// Created by wf ship-plan build — plan v2, 2026-10-05
// Dependency audit (ship plan Block K). Fails on any finding with CVSS 7.0 or higher,
// on any finding without a severity score, and on any malicious-package id (MAL-*).
// osv-scanner drops the ids listed in osv-scanner.toml until their ignoreUntil date.
// This script also fails when an entry there has no reason or no ignoreUntil date.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const CONFIG = "osv-scanner.toml";
const THRESHOLD = 7.0;

function checkIgnoreEntries() {
  if (!existsSync(CONFIG)) return [];
  const tables = readFileSync(CONFIG, "utf8").split(/^(?=\s*\[)/m);
  const problems = [];
  for (const table of tables) {
    if (!/^\s*\[\[IgnoredVulns\]\]/.test(table)) continue;
    const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(table)?.[1] ?? "(no id)";
    if (!/^\s*reason\s*=\s*"[^"\s][^"]*"/m.test(table)) problems.push(`${id}: no reason`);
    if (!/^\s*ignoreUntil\s*=\s*\S+/m.test(table)) problems.push(`${id}: no ignoreUntil date`);
  }
  return problems;
}

function scan() {
  const result = spawnSync(
    "osv-scanner",
    ["scan", "source", "--recursive", "--format", "json", "."],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" },
  );
  // Exit 0: no findings. Exit 1: findings. Any other exit is a scanner failure.
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`osv-scanner failed with exit code ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function findFailures(report) {
  const failures = [];
  for (const source of report.results ?? []) {
    for (const pkg of source.packages ?? []) {
      const info = pkg.package ?? {};
      const name = `${info.ecosystem}/${info.name}@${info.version}`;
      for (const group of pkg.groups ?? []) {
        const ids = group.ids ?? [];
        const allIds = [...ids, ...(group.aliases ?? [])];
        const raw = group.max_severity ?? "";
        const score = raw === "" ? Number.NaN : Number(raw);
        let why = "";
        if (allIds.some((id) => id.startsWith("MAL-"))) why = "malicious package";
        else if (Number.isNaN(score)) why = "no severity score";
        else if (score >= THRESHOLD) why = `CVSS ${score}`;
        if (why) failures.push(`${name}: ${ids.join(", ")} (${why})`);
      }
    }
  }
  return failures;
}

const configProblems = checkIgnoreEntries();
for (const problem of configProblems) console.error(`${CONFIG}: ${problem}`);

const failures = findFailures(scan());
for (const failure of failures) console.error(failure);

if (configProblems.length > 0 || failures.length > 0) {
  console.error(
    `Dependency audit failed: ${failures.length} finding(s), ${configProblems.length} ${CONFIG} problem(s).`,
  );
  process.exit(1);
}
console.log("Dependency audit passed.");
