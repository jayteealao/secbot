// Created by wf ship-plan build — plan v2, 2026-10-05
// License gate (ship plan Block K). Reads `pnpm licenses list --json` for the workspace
// root and every workspace package, dev dependencies included. A package passes only
// when its SPDX expression is satisfiable with allowlisted licenses. Every other license
// fails, including the GPL and AGPL family and an unknown license.
import { spawnSync } from "node:child_process";

const ALLOW = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "0BSD",
  "Python-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "BlueOak-1.0.0",
  "Unlicense",
]);

function listLicenses(extraArgs) {
  const result = spawnSync("pnpm", [...extraArgs, "licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `pnpm ${extraArgs.join(" ")} licenses list failed with exit code ${result.status}`,
    );
  }
  const text = result.stdout.trim();
  return text === "" ? {} : JSON.parse(text);
}

// SPDX: AND binds tighter than OR. A WITH exception is not on the allowlist.
function isAllowed(expression) {
  const tokens = expression.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/);
  let i = 0;
  const keyword = () => tokens[i]?.toUpperCase();
  function term() {
    const token = tokens[i++];
    if (token === undefined) throw new Error("unexpected end");
    if (token === "(") {
      const value = anyOf();
      if (tokens[i++] !== ")") throw new Error("unbalanced parentheses");
      return value;
    }
    if (keyword() === "WITH") {
      i += 2;
      return false;
    }
    return ALLOW.has(token);
  }
  function allOf() {
    let value = term();
    while (keyword() === "AND") {
      i++;
      const right = term();
      value = value && right;
    }
    return value;
  }
  function anyOf() {
    let value = allOf();
    while (keyword() === "OR") {
      i++;
      const right = allOf();
      value = value || right;
    }
    return value;
  }
  try {
    const value = anyOf();
    return i === tokens.length && value;
  } catch {
    return false;
  }
}

const failures = new Set();
for (const report of [listLicenses([]), listLicenses(["-r"])]) {
  for (const [license, packages] of Object.entries(report)) {
    if (isAllowed(license)) continue;
    for (const pkg of packages) {
      failures.add(`${pkg.name}@${(pkg.versions ?? []).join(",")}: ${license}`);
    }
  }
}

if (failures.size > 0) {
  for (const failure of [...failures].sort()) console.error(failure);
  console.error(`License check failed: ${failures.size} package(s) outside the allowlist.`);
  process.exit(1);
}
console.log("License check passed.");
