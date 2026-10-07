// Created by wf ship-plan build — plan v2, 2026-10-05
// Patched by wf ship-plan build — plan v3, 2026-10-07
// License gate (ship plan Block K). Reads the `license` (or legacy `licenses`) field from
// every installed package's package.json in pnpm's virtual store (node_modules/.pnpm), so the
// gate covers the root and every workspace package, dev and transitive dependencies included,
// and does not depend on `pnpm licenses list` (which fails on a git-hosted dependency). A
// package passes only when its SPDX expression is satisfiable with allowlisted licenses. Every
// other license fails, including the GPL and AGPL family and an unknown license.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The license expression one package.json declares: `license` as a string or { type }, else the
// legacy `licenses` array (joined with OR), else "Unknown".
export function licenseOf(manifest) {
  const single = typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
  if (typeof single === "string" && single.trim() !== "") return single.trim();
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type) => typeof type === "string" && type.trim() !== "")
      .map((type) => type.trim());
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return "Unknown";
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

// Every package installed in pnpm's virtual store: <store>/<entry>/node_modules/<name>. Besides
// the entry's own package, that folder holds links to its dependencies; a link resolves outside
// the entry, so only the folder that really lives inside it is the entry's package.
export function collectInstalled(storeDir) {
  const found = new Map();
  let entries;
  try {
    entries = readdirSync(storeDir, { withFileTypes: true });
  } catch {
    throw new Error(`no installed packages at ${storeDir}: run pnpm install first`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const modules = join(storeDir, entry.name, "node_modules");
    let names;
    try {
      names = readdirSync(modules);
    } catch {
      continue;
    }
    const own = realpathSync(modules);
    const candidates = names.flatMap((name) =>
      name.startsWith("@")
        ? readdirSync(join(modules, name)).map((sub) => `${name}/${sub}`)
        : [name],
    );
    for (const name of candidates) {
      if (name.startsWith(".")) continue;
      const dir = join(modules, name);
      let real;
      try {
        real = realpathSync(dir);
      } catch {
        continue;
      }
      if (!real.startsWith(own)) continue;
      const manifest = readManifest(real);
      if (manifest === undefined) continue;
      const key = `${manifest.name ?? name}|${manifest.version ?? "unknown"}`;
      found.set(key, {
        name: manifest.name ?? name,
        version: manifest.version ?? "unknown",
        license: licenseOf(manifest),
      });
    }
  }
  return [...found.values()];
}

// One "name@versions: license" line per package outside the allowlist, sorted.
export function findFailures(packages) {
  const grouped = new Map();
  for (const pkg of packages) {
    if (isAllowed(pkg.license)) continue;
    const key = `${pkg.name}|${pkg.license}`;
    const group = grouped.get(key) ?? { name: pkg.name, license: pkg.license, versions: new Set() };
    group.versions.add(pkg.version);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => `${group.name}@${[...group.versions].sort().join(",")}: ${group.license}`)
    .sort();
}

// SPDX: AND binds tighter than OR. A WITH exception is not on the allowlist.
export function isAllowed(expression) {
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

function main() {
  const failures = findFailures(collectInstalled(join(root, "node_modules", ".pnpm")));
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`License check failed: ${failures.length} package(s) outside the allowlist.`);
    process.exit(1);
  }
  console.log("License check passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
