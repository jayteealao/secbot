// node --test scripts/ — the samples are assembled at run time, so this file never holds one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllowlist, scanText } from "./check-identifiers.mjs";

const dot = (...parts) => parts.join(".");
const hex32 = "0123456789abcdef".repeat(2);
const samples = {
  cgnat: dot(100, 101, 7, 9),
  publicAddress: dot(81, 7, 12, 200),
  tailnet: `${["vps", "tail1234"].join(".")}.ts.net`,
  r2Endpoint: `https://${hex32}.r2.cloudflarestorage.com`,
  r2EndpointEu: `https://${hex32}.eu.r2.cloudflarestorage.com`,
  accountVar: `account_id = "${hex32}"`,
  heartbeat: `https://uptime.${"betterstack"}.com/api/v1/heartbeat/${"Ab12".repeat(5)}`,
  key: `-----BEGIN ${"OPENSSH PRIVATE"} KEY-----`,
};

test("flags every planted identifier", () => {
  for (const [name, sample] of Object.entries(samples)) {
    const findings = scanText("infra/example.tf", `value = ${sample}\n`);
    assert.equal(findings.length, 1, `${name} should be flagged once: ${JSON.stringify(findings)}`);
  }
});

test("labels a private-network address", () => {
  const [finding] = scanText("a.yml", `host: ${samples.cgnat}`);
  assert.equal(finding?.what, "private-network (CGNAT) address");
  assert.equal(finding?.line, 1);
});

test("allows loopback, the any-address, documentation ranges, and versions", () => {
  const clean = [
    dot(127, 0, 0, 1),
    dot(0, 0, 0, 0),
    dot(192, 0, 2, 10),
    dot(198, 51, 100, 3),
    dot(203, 0, 113, 99),
    "version 1.2.3",
    dot(1, 2, 3, 4, 5),
    dot(300, 1, 1, 1),
    "a hash 0123456789abcdef0123456789abcdef with no account context",
  ].join("\n");
  assert.deepEqual(scanText("README.md", clean), []);
});

test("honors the allowlist by path and text", () => {
  const allow = parseAllowlist(
    `# comment\n\ndocs/x.md | ${samples.publicAddress} | a public mirror\n`,
  );
  assert.deepEqual(scanText("docs/x.md", samples.publicAddress, allow), []);
  assert.equal(scanText("docs/y.md", samples.publicAddress, allow).length, 1);
  assert.throws(() => parseAllowlist("only-a-path"), /path \| text \| reason/);
});

test("the repository itself is clean", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = execFileSync(process.execPath, [join(root, "scripts", "check-identifiers.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /no address, hostname, account id, ping URL, or key found/);
});

test("conformance output uses the runbook phrases", async () => {
  const { reportSuite, reportLongTransaction, chooseTarget } = await import("./conformance.mjs");
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(
    reportSuite(
      { adapter: "CelldSqliteDatabase", passed: 2, failed: 0, cases: [{ ok: true }, { ok: true }] },
      log,
    ),
    0,
  );
  assert.equal(
    reportSuite(
      {
        adapter: "NodeSqliteDatabase",
        passed: 0,
        failed: 1,
        cases: [{ name: "c", ok: false, error: "e" }],
      },
      log,
    ),
    2,
  );
  assert.equal(
    reportSuite({ adapter: "CelldSqliteDatabase", passed: 0, failed: 0, cases: [] }, log),
    1,
  );
  assert.ok(lines.includes("conformance case fail: c: e"));
  assert.ok(lines.includes("storage conformance suite: 0 passed, 1 failed"));
  assert.ok(lines.some((line) => line.startsWith("adapter mismatch: NodeSqliteDatabase")));
  assert.equal(
    reportLongTransaction(
      { longTransaction: { timedOut: true }, after: { markerRowsVisible: 0 } },
      log,
    ),
    0,
  );
  assert.equal(
    reportLongTransaction(
      { longTransaction: { error: "x" }, after: { markerRowsVisible: 1 } },
      log,
    ),
    2,
  );
  assert.equal(
    chooseTarget(undefined, { SECBOT_VPS_SSH: "alias" }, () => false),
    "test-cell",
  );
  assert.equal(
    chooseTarget(undefined, {}, () => true),
    "local",
  );
  assert.throws(() => chooseTarget(undefined, {}, () => false), /no celld/);
  assert.throws(() => chooseTarget("elsewhere"), /unknown target/);
});

test("the VPS client refuses unsafe words and needs an SSH alias", async () => {
  const { remoteCommand, sshTarget } = await import("./vps.mjs");
  assert.equal(
    remoteCommand(["deploy", "--env", "test-cell", "--version", "v1.2.3"]),
    "deploy --env test-cell --version v1.2.3",
  );
  assert.throws(() => remoteCommand(["deploy", "x; rm -rf /"]), /refusing argument/);
  assert.equal(sshTarget({ SECBOT_VPS_SSH: "my-alias" }), "my-alias");
  assert.equal(sshTarget({ GITHUB_ACTIONS: "true" }), "secbot-vps");
  assert.throws(() => sshTarget({}), /SECBOT_VPS_SSH is not set/);
});
