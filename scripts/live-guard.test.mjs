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
import {
  checkModels,
  executeSteps,
  PREFLIGHT_PAD,
  preflight,
  setTestModels,
  writeEvidence,
} from "./live-guard.mjs";
import {
  ALL_CHECKS,
  BANK_REMINDER,
  buildReport,
  CARD_REMINDER,
  CLEARING_FILES,
  CONTRACT,
  check,
  decisionModelOf,
  fillArgv,
  fixedLimit,
  literalHits,
  modelsProblem,
  newestHeld,
  overSpend,
  parseModelList,
  percentile,
  placeLimit,
  STEPS,
  scrub,
  spendOf,
  stepsOf,
  TEST_CELL_MODEL,
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

test("the owner-rule matchers read the rules list, the held call, and the denial", async () => {
  const rules = [
    "OWNER RULES (you cannot loosen these)",
    "------------------------------------------------------------------------------",
    "AGENT   TOOL               MATCH                          VERDICT",
    "all     pay tools          any                            prohibit",
    "all     set_reminder       text ~ /\\b\\d(?:[ \\-\\u2010-\\u2015]?\\d){12,18}\\b/i",
    "                                                          ask first",
    "all     search_history     query ~ /\\b(?:password|passcode|pin|token|api[ _\\-]?",
    "                           key)\\b/i",
    "                                                          ask first",
  ].join("\n");
  assert.deepEqual(
    check(rules, { expect: [CONTRACT.ownerCardRule, CONTRACT.ownerSecretRule] }).missing,
    [],
  );
  const held = [
    "[ HELD #3 ] the lead wants to run a tool                  lapses in 23 h 59 m",
    "  agent      lead",
    "  tool       set_reminder",
    "  why held   owner rule: all set_reminder (text ~ /\\b\\d(?:[",
    "             \\-\\u2010-\\u2015]?\\d){12,18}\\b/i) -> ask first",
    "  answer     /allow 3     allow once",
    "             (allow always is not offered: an owner rule asks first here)",
    "             /deny 3      deny",
  ].join("\n");
  assert.deepEqual(
    check(held, {
      expect: [CONTRACT.held, CONTRACT.heldOwnerCard, CONTRACT.alwaysNotOffered],
      reject: [CONTRACT.alwaysLine],
    }),
    { missing: [], present: [] },
  );
  assert.ok(
    CONTRACT.heldOwnerSecret.test(
      "  why held   owner rule: all search_history (query ~ /\\b(?:password|passcode|pin|",
    ),
  );
  assert.ok(
    CONTRACT.deniedReminder.test('[ denied ] #3 set_reminder; the lead was told "denied by sam"'),
  );
  assert.ok(
    CONTRACT.deniedSearch.test('[ denied ] #4 search_history; the lead was told "denied by sam"'),
  );
  assert.ok(CONTRACT.alwaysLine.test("             /always 1    allow always; adds: lead handoff"));
  // Charter step 7's reminder holds no card number, so no owner rule holds it; the card step's does.
  const { CARD_NUMBER_PATTERN } = await import("../packages/cell-harness/src/release-defaults.ts");
  const card = new RegExp(CARD_NUMBER_PATTERN, "i");
  assert.equal(card.test(BANK_REMINDER), false);
  assert.equal(card.test(CARD_REMINDER), true);
  const c7 = STEPS.find((step) => step.id === "c7");
  const texts = (c7?.actions ?? []).flatMap((action) => [
    action.say ?? "",
    ...(action.plainer ?? []),
  ]);
  assert.ok(texts.length > 0);
  for (const text of texts) assert.equal(card.test(text), false, text);
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
    "owner-rules",
  ]) {
    assert.ok(ALL_CHECKS.includes(name), name);
  }
  // The owner-rule steps run in part 1, before charter step 1.
  const ids = stepsOf(1).map((step) => step.id);
  assert.deepEqual(ids.slice(ids.indexOf("o1"), ids.indexOf("c1")), ["o1", "o2", "o3", "o4"]);
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
    assert.ok(missing.lines.includes(`${"OPENROUTER_API_KEY".padEnd(PREFLIGHT_PAD)}missing`));
    // The longest label keeps two spaces before its value.
    assert.equal(PREFLIGHT_PAD, "device key listed for its person".length + 2);
    assert.ok(missing.lines.includes("device key listed for its person  no"));
    assert.ok(ready.lines.includes("device key listed for its person  yes"));
    for (const line of ready.lines.slice(0, -1))
      assert.match(line.slice(PREFLIGHT_PAD - 2), /^ {2}\S/);
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

test("a command with a wait reruns until a row that lands after the chat turn appears", async () => {
  let reads = 0;
  const deps = fakeDeps({ answers: {}, chatReplies: () => "", spends: [1] });
  const plain = deps.cli.bind(deps);
  deps.cli = async (argv, options) => {
    if (argv[0] !== "activity") return plain(argv, options);
    reads += 1;
    return {
      code: 0,
      out: reads < 3 ? "nothing yet\n" : "lead  search_history  refused\n",
      err: "",
    };
  };
  const steps = [
    {
      id: "late",
      part: 1,
      checks: ["check-late"],
      evidence: "charter-part1.txt",
      actions: [{ kind: "cmd", argv: ["activity"], expect: [/refused/], waitMs: 60_000 }],
    },
    {
      id: "never",
      part: 1,
      checks: ["check-never"],
      evidence: "charter-part1.txt",
      actions: [{ kind: "cmd", argv: ["activity"], expect: [/allowed/], waitMs: 1_000 }],
    },
  ];
  const { results } = await executeSteps(
    steps,
    deps,
    { person: "owner", values: {} },
    { startSpend: 1 },
    5,
  );
  assert.equal(results.late.status, "pass");
  assert.equal(reads >= 3, true);
  assert.equal(results.never.status, "fail");
});

test("in shadow mode the secret read and the brokered call pass whatever the reviewer would say", () => {
  const c8 = STEPS.find((step) => step.id === "c8");
  const activity = c8.actions.at(-1);
  const row = (agent, tool, verdict) => `09:46  ${agent.padEnd(9)}  ${tool.padEnd(23)}  ${verdict}`;
  const text = [
    row("lead", "secret live-test-secret", "refused       secrets"),
    row("research", "secret_get", "would ask     reviewer"),
    row("health", "broker_call", "allowed       decision"),
  ].join("\n");
  assert.equal(check(text, { expect: activity.expect, reject: [] }).missing.length, 0);
  assert.ok(activity.waitMs > 0);
});

/** A fake cell for the models step: `secbot model list`, `model set`, `mode show`, `mode decision`. */
function modelCell({ roles, decisionModel }) {
  const state = { roles: roles.map((entry) => ({ ...entry })), decisionModel, calls: [] };
  const cli = async (argv) => {
    state.calls.push(argv.join(" "));
    const [command, sub, a, b] = argv;
    if (command === "model" && sub === "list") {
      const width = Math.max(...state.roles.map((entry) => entry.role.length));
      const out = state.roles
        .map((entry) => `${entry.role.padEnd(width)}  ${entry.model}  (${entry.source})\n`)
        .join("");
      return { code: 0, out, err: "" };
    }
    if (command === "model" && sub === "set") {
      const entry = state.roles.find((each) => each.role === a);
      if (entry === undefined) return { code: 1, out: "", err: "secbot: unknown role\n" };
      entry.model = b;
      entry.source = "changed";
      return { code: 0, out: `${a} now uses ${b} from its next turn\n`, err: "" };
    }
    if (command === "mode" && sub === "show") {
      return {
        code: 0,
        out: `${a}  mode shadow  since 9 Oct 07:40  decision model ${state.decisionModel}\n`,
        err: "",
      };
    }
    if (command === "mode" && sub === "decision") {
      state.decisionModel = b;
      return {
        code: 0,
        out: `${a} now uses the ${b} decision model from the next call\n`,
        err: "",
      };
    }
    return { code: 2, out: "", err: "usage\n" };
  };
  return { state, deps: { cli } };
}

const RELEASE_ROLES = [
  { role: "lead", model: "anthropic/claude-opus-5.5", source: "release default" },
  { role: "household", model: "anthropic/claude-haiku-4.5", source: "release default" },
  { role: "developer", model: "anthropic/claude-haiku-4.5", source: "release default" },
  { role: "research", model: "anthropic/claude-haiku-4.5", source: "release default" },
  { role: "health", model: "anthropic/claude-haiku-4.5", source: "release default" },
  { role: "reviewer", model: "anthropic/claude-sonnet-5.5", source: "release default" },
];

test("the models step moves every Opus role to Sonnet and the decision model to Jev, once", async () => {
  const { state, deps } = modelCell({ roles: RELEASE_ROLES, decisionModel: "clef" });
  const first = await setTestModels(deps, "owner");
  assert.equal(first.problem, undefined);
  assert.equal(TEST_CELL_MODEL, "anthropic/claude-sonnet-5.5");
  assert.deepEqual(
    state.calls.filter((call) => / set | decision /.test(call)),
    ["model set lead anthropic/claude-sonnet-5.5", "mode decision owner jev"],
  );
  // Haiku and Sonnet roles are not touched.
  assert.deepEqual(
    state.roles.map((entry) => `${entry.role} ${entry.model}`),
    [
      "lead anthropic/claude-sonnet-5.5",
      "household anthropic/claude-haiku-4.5",
      "developer anthropic/claude-haiku-4.5",
      "research anthropic/claude-haiku-4.5",
      "health anthropic/claude-haiku-4.5",
      "reviewer anthropic/claude-sonnet-5.5",
    ],
  );
  assert.match(first.text, /\$ secbot model set lead anthropic\/claude-sonnet-5\.5\n/);
  assert.match(first.text, /\[models: pass\]\n$/);
  // A second run reads the models and changes nothing.
  state.calls.splice(0);
  const second = await setTestModels(deps, "owner");
  assert.equal(second.problem, undefined);
  assert.ok(
    state.calls.every((call) => !/ set | decision /.test(call)),
    state.calls.join("; "),
  );
  assert.ok(first.text.split("\n").every((line) => line.length <= 80));
});

test("the charter refuses to start while a role uses Opus or the decision model is not Jev", async () => {
  const opus = modelCell({ roles: RELEASE_ROLES, decisionModel: "jev" });
  assert.equal(
    await checkModels(opus.deps, "owner"),
    "an Opus model is set for lead; run live:guard -- models first",
  );
  const clef = modelCell({
    roles: RELEASE_ROLES.map((entry) =>
      entry.role === "lead" ? { ...entry, model: TEST_CELL_MODEL, source: "changed" } : entry,
    ),
    decisionModel: "clef",
  });
  assert.equal(
    await checkModels(clef.deps, "owner"),
    "the decision model is clef, not jev; run live:guard -- models first",
  );
  // Checking never changes a model.
  assert.ok(clef.state.calls.every((call) => !/ set | decision /.test(call)));
  await setTestModels(clef.deps, "owner");
  assert.equal(await checkModels(clef.deps, "owner"), undefined);
  assert.equal(modelsProblem([], "jev"), "no model list from secbot model list");
  assert.deepEqual(parseModelList("lead      anthropic/claude-opus-5.5  (release default)\n"), [
    { role: "lead", model: "anthropic/claude-opus-5.5", source: "release default" },
  ]);
  assert.equal(decisionModelOf("owner  mode shadow  decision model jev\n"), "jev");
  assert.equal(decisionModelOf("no such line"), undefined);
});
