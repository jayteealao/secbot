#!/usr/bin/env node
// The live jobs check on the test cell: runs the steps in scripts/live-jobs-steps.mjs against the
// deployed test cell with the real `secbot` command line, as the owner, the second person, and
// the operator, and writes the evidence.
//
//   node scripts/live-jobs.mjs preflight
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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflight as guardPreflight,
  privateValues as guardPrivateValues,
  PREFLIGHT_PAD,
} from "./live-guard.mjs";

/** The person the second device file must name. */
export const SECOND_PERSON = "second";

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

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

const main = async () => {
  const [command] = process.argv.slice(2);
  if (command === "preflight") {
    const ready = await preflight();
    console.log(ready.lines.join("\n"));
    return ready.ok ? 0 : 1;
  }
  console.error("usage: live-jobs.mjs preflight");
  return 2;
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
