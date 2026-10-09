// node:test tests for the live guard check's helpers (scripts/live-guard-steps.mjs) and driver
// (scripts/live-guard.mjs): the scrubber, the evidence scan, the contract matchers, the limit
// placement, the percentile, the spend stop, the report, preflight, and the step runner on fake
// processes. Nothing here reaches a cell or an outside account.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeSteps, preflight, writeEvidence } from "./live-guard.mjs";
import {
  ALL_CHECKS,
  buildReport,
  CLEARING_FILES,
  CONTRACT,
  check,
  fillArgv,
  fixedLimit,
  literalHits,
  newestHeld,
  overSpend,
  percentile,
  placeLimit,
  STEPS,
  scrub,
  spendOf,
  stepsOf,
} from "./live-guard-steps.mjs";

// Built at run time, so this file itself never holds an address or a private hostname.
const ADDRESS = ["10", "20", "30", "40"].join(".");
const HOST = ["cell-7", "example-tail", "ts", "net"].join(".");
const CELL_URL = `https://${HOST}:8443`;
const KEY = "owner-laptop-key-live-0123456789abcdef"; // gitleaks:allow (fake test key)

test("the scrubber replaces a URL whole, its host inside a sentence, and a key", () => {
  const values = { "cell-url": CELL_URL, "device-key": KEY };
  const text = [
    `connected to ${CELL_URL}/fake-target`,
    `the host ${HOST} answered`,
    `key=${KEY};`,
  ].join("\n");
  const clean = scrub(text, values);
  assert.equal(
    clean,
    [
      "connected to <cell-url>/fake-target",
      "the host <cell-url-host> answered",
      "key=<device-key>;",
    ].join("\n"),
  );
  assert.deepEqual(literalHits(clean, values), []);
  assert.deepEqual(literalHits(text, values).sort(), ["cell-url", "cell-url-host", "device-key"]);
  // Short or empty values are never used as patterns.
  assert.equal(scrub("a b c", { x: "", y: "b" }), "a b c");
});

test("evidence with an address or a private value is refused and not written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-guard-"));
  try {
    await assert.rejects(
      writeEvidence(dir, "bad.txt", `reached ${ADDRESS} at noon\n`, {}),
      /bad\.txt still holds a private value \(ip-address\)/,
    );
    assert.equal(existsSync(join(dir, "bad.txt")), false);
    // A value scrubbed in memory is written as its placeholder.
    await writeEvidence(dir, "good.txt", `the cell ${CELL_URL} said hi\n`, {
      "cell-url": CELL_URL,
    });
    assert.equal(await readFile(join(dir, "good.txt"), "utf8"), "the cell <cell-url> said hi\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the matchers read the command line's contract lines", () => {
  const held = [
    "[ HELD #1 ] the lead wants to run a tool                  lapses in 23 h 58 m",
    "  why held   your rule: lead handoff (any) -> ask first",
    "  answer     /allow 1     allow once",
    "             /always 1    allow always; adds: lead handoff",
  ].join("\n");
  assert.deepEqual(check(held, { expect: [CONTRACT.held, CONTRACT.heldYourRule] }).missing, []);
  assert.equal(newestHeld(`${held}\n[ HELD #2 of 2 ] the lead wants to run a tool`), 2);
  assert.equal(newestHeld("nothing held"), undefined);
  assert.ok(
    CONTRACT.heldOwnerRule.test(
      "  why held   owner rule: all handoff (specialist = developer) -> ask first",
    ),
  );
  assert.ok(
    CONTRACT.alwaysNotOffered.test(
      "             (allow always is not offered: an owner rule asks first here)",
    ),
  );
  assert.ok(
    CONTRACT.allowedAlways.test(
      "[ allowed always ] #1 handoff -> research; added rule: lead handoff",
    ),
  );
  assert.ok(CONTRACT.allowedOnce.test("[ allowed once ] #2 handoff -> developer"));
  for (const line of [
    "[ month: $11.52 / $25.00 ] [#####.....] 46% [ shadow ]",
    "[ month: $20.40 / $25.00 ] [########..] 82% [ 80% of limit ] [ shadow ]",
    "[ month: $25.30 / $25.00 ] [##########] 101% [ limit reached ] [ shadow ]",
  ]) {
    assert.ok(CONTRACT.usage.test(line), line);
  }
  assert.deepEqual(spendOf("[ month: $20.40 / $25.00 ] [########..] 82%"), {
    spend: 20.4,
    limit: 25,
  });
  assert.equal(spendOf("no usage line"), undefined);
  const missing = check("hello", { expect: [CONTRACT.warn], reject: [/hello/] });
  assert.deepEqual(missing.missing, [CONTRACT.warn]);
  assert.deepEqual(
    missing.present.map((pattern) => pattern.source),
    ["hello"],
  );
});

test("the limit is placed from the measured spend, never under one cent", () => {
  assert.equal(placeLimit(0.6, "place-80"), "0.80");
  assert.equal(placeLimit(0.61, "place-80"), "0.82");
  assert.equal(placeLimit(0.6, "below"), "0.59");
  assert.equal(placeLimit(0, "place-80"), "0.01");
  assert.equal(placeLimit(0, "below"), "0.01");
  assert.throws(() => placeLimit(1, "sideways"), /unknown limit line/);
  assert.equal(fixedLimit("test", { spendUsd: 0.2 }), "1.00");
  // At 75% of $1.00 already: setting it would cross a line out of turn, so it is skipped.
  assert.equal(fixedLimit("test", { spendUsd: 0.75 }), undefined);
  assert.equal(fixedLimit("restore", { original: 40 }), "40.00");
  assert.equal(fixedLimit("restore", { original: undefined }), "25.00");
});

test("the percentile is nearest rank; the spend stop is a rise above the cap", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
  assert.equal(overSpend(1, 6.01, 5), true);
  assert.equal(overSpend(1, 6, 5), false);
  assert.equal(overSpend(undefined, 9, 5), false);
});

test("the step list fills person and target at run time and covers every criterion", () => {
  assert.deepEqual(
    fillArgv(["rules", "--person", "{person}", "--url", "{fakeTarget}"], {
      person: "owner",
      fakeTarget: "x",
    }),
    ["rules", "--person", "owner", "--url", "x"],
  );
  for (const name of [
    "rules-list",
    "held-call",
    "limit-notices",
    "usage-line",
    "activity",
    "secret-grants",
    "secret-broker",
    "cli-text",
  ]) {
    assert.ok(ALL_CHECKS.includes(name), name);
  }
  for (let n = 1; n <= 10; n++) assert.ok(ALL_CHECKS.includes(`charter-${n}`), `charter-${n}`);
  const evidence = new Set(STEPS.map((step) => step.evidence));
  for (const file of CLEARING_FILES) assert.ok(evidence.has(file), file);
  assert.equal(stepsOf(2).at(-1)?.id, "cleanup");
  // No step's command line carries a value: only the two run-time placeholders.
  const words = STEPS.flatMap((step) => step.actions.flatMap((action) => action.argv ?? []));
  assert.deepEqual(
    words
      .filter((word) => word.startsWith("{"))
      .filter((word) => !["{person}", "{fakeTarget}"].includes(word)),
    [],
  );
});

test("the report reads pass, fail with its last lines, or not run, per step and per criterion", () => {
  const steps = [
    { id: "a", checks: ["check-1"], actions: [] },
    { id: "b", checks: ["check-1", "check-2"], actions: [] },
    { id: "c", checks: ["check-3"], actions: [] },
  ];
  const text = buildReport(
    { a: { status: "pass" }, b: { status: "fail", detail: "missing x", last: "l1\nl2" } },
    steps,
  );
  const lines = text.split("\n");
  assert.ok(lines.includes("a                    pass"));
  assert.ok(lines.includes("b                    fail: missing x"));
  assert.ok(lines.includes("    l2"));
  assert.ok(lines.includes("c                    not run"));
  assert.ok(lines.includes("check-1              fail"));
  assert.ok(lines.includes("check-2              fail"));
  assert.ok(lines.includes("check-3              not run"));
  assert.ok(lines.every((line) => line.length <= 80));
});

test("preflight prints SET or missing and never a value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-guard-pre-"));
  try {
    await writeFile(
      join(dir, "device.json"),
      JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
    );
    const hash = createHash("sha256").update(KEY).digest("hex");
    const env = {
      SECBOT_CONFIG_DIR: dir,
      SECBOT_CELL_URL: CELL_URL,
      SECBOT_VPS_SSH: "alias-x",
      OPENROUTER_API_KEY: "sk-or-test-not-a-real-key-000", // gitleaks:allow (fake test key)
      BETTERSTACK_INCIDENTS_TOKEN: "bs-test-token",
      BETTERSTACK_REQUESTER_EMAIL: "owner@example.com",
      SECBOT_DEVICE_KEYS: `laptop:owner:${hash}`,
      SECBOT_TIME_ZONE: "Europe/London",
      SECBOT_OPERATOR_KEY: "operator-test-key-0000",
    };
    const ready = await preflight(env, dir);
    assert.equal(ready.ok, true);
    assert.equal(ready.lines.at(-1), "preflight: ready");
    const text = ready.lines.join("\n");
    for (const value of Object.values(env)) {
      if (value !== dir) assert.ok(!text.includes(value), "a value was printed");
    }
    const missing = await preflight(
      { ...env, OPENROUTER_API_KEY: "", SECBOT_DEVICE_KEYS: "x:owner:0" },
      dir,
    );
    assert.equal(missing.ok, false);
    assert.ok(missing.lines.includes(`${"OPENROUTER_API_KEY".padEnd(30)}missing`));
    assert.ok(missing.lines.includes(`${"device key listed for its person".padEnd(30)}no`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Fake processes: a command answers from a table; the chat prints what a script says. */
function fakeDeps({ answers, chatReplies, spends }) {
  let text = "";
  let open = false;
  let costReads = 0;
  return {
    sent: [],
    calls: [],
    scale: 0.001,
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 5))),
    async cli(argv, { stdin } = {}) {
      this.calls.push({ argv, stdin });
      if (argv[0] === "cost") {
        const spend = spends[Math.min(costReads++, spends.length - 1)];
        return {
          code: 0,
          out: `[ month: $${spend.toFixed(2)} / $25.00 ] [..........] 0%\n`,
          err: "",
        };
      }
      return answers[argv.join(" ")] ?? { code: 0, out: "ok\n", err: "" };
    },
    chat: {
      isOpen: () => open,
      text: () => text,
      async open() {
        open = true;
        text += "connected to owner lead\n[ month: $0.10 / $25.00 ] [..........] 0% [ shadow ]\n";
      },
      send: async (line) => {
        text += chatReplies(line) ?? "";
      },
      async close() {
        open = false;
      },
    },
  };
}

test("the step runner passes, marks a model miss not run, a wrong command fail, and stops on spend", async () => {
  const steps = [
    {
      id: "one",
      part: 1,
      checks: ["check-1"],
      evidence: "one.txt",
      actions: [
        { kind: "cmd", argv: ["rules", "list", "--person", "{person}"], expect: [/RULES/] },
        { kind: "stdin", argv: ["secrets", "add"], value: "testSecret", expect: [/stored/] },
        { kind: "chat", say: "hand off", expect: [CONTRACT.held] },
        { kind: "answer", choice: "allow", expect: [CONTRACT.allowedOnce] },
      ],
    },
    {
      id: "two",
      part: 1,
      checks: ["check-2"],
      evidence: "charter-part1.txt",
      actions: [{ kind: "chat", say: "ignored", plainer: ["still ignored"], expect: [/never/] }],
    },
    {
      id: "three",
      part: 1,
      checks: ["check-3"],
      evidence: "charter-part1.txt",
      actions: [{ kind: "cmd", argv: ["activity"], expect: [/refused/] }],
    },
    { id: "four", part: 1, checks: ["check-4"], evidence: "charter-part1.txt", actions: [] },
    {
      id: "cleanup",
      part: 1,
      checks: [],
      cleanup: true,
      evidence: "cleanup.txt",
      actions: [{ kind: "limit", to: "restore", expect: [/now/] }],
    },
  ];
  const deps = fakeDeps({
    answers: {
      "rules list --person owner": { code: 0, out: "YOUR RULES\n", err: "" },
      "secrets add": { code: 0, out: "[ stored ] test\n", err: "" },
      activity: { code: 0, out: "nothing\n", err: "" },
      "limits set owner 40.00": {
        code: 0,
        out: "owner's monthly limit is now $40.00 from the next call\n",
        err: "",
      },
    },
    chatReplies: (line) =>
      line === "hand off"
        ? "\n[ HELD #3 ] the lead wants to run a tool\n"
        : line === "/allow 3"
          ? "[ allowed once ] #3 handoff -> research\n"
          : "lead: fine\n",
    // The third read (after step three) is $6 above the start: the run stops before step four.
    spends: [1, 1, 7.5],
  });
  const state = { startSpend: 1, originalLimit: 40 };
  const { results, evidence } = await executeSteps(
    steps,
    deps,
    { person: "owner", fakeTarget: "x", values: { testSecret: "the-secret-value" } },
    state,
    5,
  );
  assert.equal(results.one.status, "pass");
  assert.equal(results.two.status, "not run");
  assert.match(results.two.detail, /^the model did not: missing never/);
  assert.equal(results.three.status, "fail");
  assert.equal(results.four.status, "not run");
  assert.match(results.four.detail, /stopped: the month's spend rose by more than \$5/);
  assert.equal(results.cleanup.status, "pass");
  // The secret went on standard input only; the transcript shows the command, not the value.
  assert.deepEqual(deps.calls.find((call) => call.argv[0] === "secrets").stdin, "the-secret-value");
  assert.ok(!Object.values(evidence).join("").includes("the-secret-value"));
  assert.match(evidence["one.txt"], /\$ secbot rules list --person \{person\}/);
  assert.match(evidence["one.txt"], /> \/allow 3/);
  assert.match(evidence["charter-part1.txt"], /## one/);
  assert.match(evidence["cleanup.txt"], /limits set \{person\} 40\.00/);
});
