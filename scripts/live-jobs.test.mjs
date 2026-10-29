// The live jobs check's pure parts: preflight on a temporary home, with and without the second
// person's device.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PREFLIGHT_PAD } from "./live-guard.mjs";
import { preflight, privateValues } from "./live-jobs.mjs";

const KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef"; // gitleaks:allow (fake test key)
const SECOND_KEY = "second-laptop-key-89abcdef0123456789abcdef01234567"; // gitleaks:allow (fake test key)
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** A temporary home with the owner's device and, optionally, the second person's. */
async function home({ second }) {
  const dir = await mkdtemp(join(tmpdir(), "live-jobs-pre-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  const secondDir = join(dir, "second");
  await mkdir(secondDir);
  if (second !== undefined) {
    await writeFile(
      join(secondDir, "device.json"),
      JSON.stringify({ name: "laptop2", person: second, key: SECOND_KEY }),
    );
  }
  const env = {
    SECBOT_CONFIG_DIR: dir,
    SECBOT_SECOND_CONFIG_DIR: secondDir,
    SECBOT_CELL_URL: "https://cell.example.test",
    SECBOT_VPS_SSH: "alias-x",
    OPENROUTER_API_KEY: "sk-or-test-not-a-real-key-000", // gitleaks:allow (fake test key)
    BETTERSTACK_INCIDENTS_TOKEN: "bs-test-token",
    BETTERSTACK_REQUESTER_EMAIL: "owner@example.com",
    SECBOT_DEVICE_KEYS: `laptop:owner:${sha(KEY)},laptop2:second:${sha(SECOND_KEY)}`,
    SECBOT_TIME_ZONE: "Europe/London",
    SECBOT_OPERATOR_KEY: "operator-test-key-0000",
  };
  return { dir, env };
}

test("preflight is ready with the second person's device and never prints a value", async () => {
  const { dir, env } = await home({ second: "second" });
  try {
    const ready = await preflight(env, dir);
    assert.equal(ready.ok, true, ready.lines.join("\n"));
    assert.equal(ready.lines.at(-1), "preflight: ready");
    assert.ok(ready.lines.includes(`${"SECBOT_SECOND_CONFIG_DIR".padEnd(PREFLIGHT_PAD)}SET`));
    assert.ok(ready.lines.includes(`${"second device key listed".padEnd(PREFLIGHT_PAD)}yes`));
    const text = ready.lines.join("\n");
    for (const value of [...Object.values(env), KEY, SECOND_KEY]) {
      if (!value.startsWith(dir)) assert.ok(!text.includes(value), "a value was printed");
    }
    assert.ok(ready.lines.every((line) => line.length <= 80 || line.startsWith("SECBOT_FAKE")));
    const { values } = await privateValues(env, dir);
    assert.equal(values["second-device-key"], SECOND_KEY);
    assert.equal(values["device-key"], KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preflight is not ready without the second device, with another person's, or unlisted", async () => {
  for (const [second, keys] of [
    [undefined, undefined],
    ["owner", undefined],
    ["second", `laptop:owner:${sha(KEY)}`],
  ]) {
    const { dir, env } = await home({ second });
    try {
      const ready = await preflight(
        keys === undefined ? env : { ...env, SECBOT_DEVICE_KEYS: keys },
        dir,
      );
      assert.equal(ready.ok, false, String(second));
      assert.equal(ready.lines.at(-1), "preflight: not ready; place what is missing first");
      if (keys === undefined) {
        assert.ok(
          ready.lines.includes(`${"SECBOT_SECOND_CONFIG_DIR".padEnd(PREFLIGHT_PAD)}missing`),
        );
      } else {
        assert.ok(ready.lines.includes(`${"second device key listed".padEnd(PREFLIGHT_PAD)}no`));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const { dir, env } = await home({ second: "second" });
  try {
    const noOperator = await preflight({ ...env, SECBOT_OPERATOR_KEY: "" }, dir);
    assert.equal(noOperator.ok, false);
    assert.ok(noOperator.lines.includes(`${"operator key".padEnd(PREFLIGHT_PAD)}missing`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
