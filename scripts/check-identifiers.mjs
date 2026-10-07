#!/usr/bin/env node
// Fails when a tracked file holds an identifier that must stay out of the repo: an IP address
// (the VPS's public or private-network address), a private-network hostname, a Cloudflare
// account id, a Better Stack heartbeat URL, or a private key. gitleaks covers tokens; this
// covers what gitleaks rules do not.
//
//   node scripts/check-identifiers.mjs            every tracked file
//   node scripts/check-identifiers.mjs --staged   the staged version of staged files (pre-commit)
//
// Exceptions live in scripts/identifier-allowlist.txt, one per line: path | text | reason
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_PREFIXES = ["node_modules/", "dist/"];

const octets = (text) => text.split(".").map(Number);
const isPublicOrPrivateAddress = (text) => {
  const parts = octets(text);
  if (parts.some((part) => part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 127 || text === "0.0.0.0") return false; // loopback and the any-address
  // RFC 5737 documentation ranges, safe in examples.
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
};
const isCgnat = (text) => {
  const [a, b] = octets(text);
  return a === 100 && b >= 64 && b <= 127;
};

export const RULES = [
  {
    id: "ip-address",
    pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    keep: isPublicOrPrivateAddress,
    describe: (text) => (isCgnat(text) ? "private-network (CGNAT) address" : "IP address"),
  },
  {
    id: "tailnet-hostname",
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi,
    describe: () => "private-network hostname",
  },
  {
    id: "cloudflare-account-id",
    pattern:
      /\b[0-9a-f]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com\b|\baccount[\w-]*["'\s:=]+[0-9a-f]{32}\b/gi,
    describe: () => "Cloudflare account id",
  },
  {
    id: "heartbeat-url",
    pattern: /\b(?:uptime\.)?better(?:stack|uptime)\.com\/api\/v\d+\/heartbeat\/[A-Za-z0-9]+/gi,
    describe: () => "Better Stack heartbeat URL",
  },
  {
    id: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    describe: () => "private key",
  },
];

/** Parses `path | text | reason` lines; blank lines and # comments are ignored. */
export function parseAllowlist(text) {
  const entries = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [path, match, reason] = line.split("|").map((part) => part.trim());
    if (!path || !match || !reason)
      throw new Error(`identifier-allowlist.txt:${index + 1}: expected "path | text | reason"`);
    entries.push({ path, match });
  }
  return entries;
}

/** Returns one finding per identifier in `text` that the allowlist does not excuse. */
export function scanText(path, text, allowlist = []) {
  const findings = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        const found = match[0];
        if (rule.keep && !rule.keep(found)) continue;
        if (allowlist.some((entry) => entry.path === path && found.includes(entry.match))) continue;
        findings.push({ path, line: index + 1, rule: rule.id, what: rule.describe(found) });
      }
    }
  }
  return findings;
}

const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function trackedFiles(staged) {
  const list = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "-z"]);
  return list
    .split("\0")
    .filter((path) => path && !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function readTracked(path, staged) {
  const buffer = staged
    ? execFileSync("git", ["show", `:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(join(root, path));
  return buffer.includes(0) ? undefined : buffer.toString("utf8");
}

function main() {
  const staged = process.argv.includes("--staged");
  const allowlist = parseAllowlist(
    readFileSync(join(root, "scripts", "identifier-allowlist.txt"), "utf8"),
  );
  const findings = [];
  for (const path of trackedFiles(staged)) {
    let text;
    try {
      text = readTracked(path, staged);
    } catch {
      continue; // deleted in the working tree
    }
    if (text !== undefined) findings.push(...scanText(path, text, allowlist));
  }
  // Report where and what, never the value itself, so CI logs do not repeat it.
  for (const finding of findings) {
    console.error(
      `identifier check: ${finding.path}:${finding.line}: ${finding.what} (${finding.rule})`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `identifier check: FAIL, ${findings.length} finding(s); move the value to an environment variable`,
    );
    process.exit(1);
  }
  console.log("identifier check: no address, hostname, account id, ping URL, or key found");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
