// The live guard check on the test cell, as data: the charter scenario's steps in two parts around
// a restart, each with the command lines or chat lines to send, the output each must show (the
// contract lines of the secbot command line), the evidence file, and the criteria it serves. Both
// the live driver (scripts/live-guard.mjs) and the stand-in rehearsal
// (packages/cell-worker/test/live-guard-rehearsal.test.ts) run these same steps.
//
// Node standard library only. Every helper here is pure, so the scrubber, the matchers, the limit
// placement, the percentile, and the report are tested without a cell.

/** A model turn waits this long for its output; a plainer retry gets the same again. */
export const MODEL_TURN_MS = 120_000;
/** A specialist's answer arrives as a follow-up after the lead's own turn. */
export const FOLLOWUP_MS = 240_000;
/** The run stops itself, with cleanup, when the month's spend rises by more than this. */
export const DEFAULT_MAX_USD = 5;
/** The test limit the run starts from. */
export const TEST_LIMIT_USD = 1;
/** The limit the cleanup restores. */
export const DEFAULT_LIMIT_USD = 25;

/** The contract lines of the command line, as patterns. */
export const CONTRACT = {
  held: /\[ HELD #(\d+)(?: of \d+)? \]/,
  heldYourRule: /why held {3}your rule: lead handoff \(any\) -> ask first/,
  heldOwnerRule: /why held {3}owner rule: all handoff \(specialist = developer\) -> ask first/,
  alwaysNotOffered: /\(allow always is not offered: an owner rule asks first here\)/,
  allowedAlways: /\[ allowed always \] #\d+ handoff/,
  allowedOnce: /\[ allowed once \] #\d+ handoff/,
  usage: /\[ month: \$\d+\.\d\d \/ \$\d+\.\d\d \] \[[#.]{10}\] \d+%/,
  warn: /\[ 80% of limit \]/,
  over: /\[ limit reached \]/,
  followupResearch: /\[from research\]/,
  followupHealth: /\[from health\]/,
  heldCalls: /HELD CALLS/,
  granted: /\[ granted \]/,
  stored: /\[ stored \]/,
};

/** The text the stand-in model gets for a chat line, so the rehearsal makes the same tool call. */
const handoffScript = (specialist, brief, then) => ({
  tool: "handoff",
  args: { specialist, brief },
  ...(then === undefined ? {} : { then }),
});

const RESEARCH_BRIEF =
  "Find the direct trains from London to Leeds on Friday morning and list three departure times.";
const DEVELOPER_BRIEF = "Check whether the household list document has any empty items.";
const SECRET_BRIEF =
  "Use the secret_get tool to read the secret named live-test-secret, then reply only with how many characters it has.";
const BROKER_BRIEF =
  "Use the broker_call tool with secret health-test, method GET, and path /v1/ping, then report the answer.";

/**
 * One step: `actions` run in order. Kinds:
 *   cmd     run `secbot <argv>` once; `expect` patterns must all show in its output
 *   stdin   as cmd, with a private value (`value`: "testSecret" | "brokerToken") on standard input
 *   chat    send `say` to the open chat; `expect` patterns must show before `timeoutMs`; up to two
 *           `plainer` lines are tried after a miss; `script` is the stand-in model's tool call
 *           (`repeat`: send it again until the patterns show, at most that many times; `reject`:
 *           patterns that must not show)
 *   open    open `secbot chat`; `expect` patterns must show on connect
 *   close   end the chat's input and wait for it to exit; `reject` patterns must not show
 *   answer  send `/<choice> N` for the newest held call, or (`from: "pending"`) the one part 1
 *           left waiting (`keep: "pending"` on a chat action records it)
 *   limit   set the test person's limit: "test" ($1.00, skipped when the spend is already at 75%
 *           of it), "place-80" (spend at about 75%), "below" (one cent below the spend), or
 *           "restore" (the limit the run found, $25.00 when it found none)
 *   pause   wait `ms` (a hand-off's job settling before the next read)
 * `optional` actions (cleanup) never fail their step.
 * `{person}` and `{fakeTarget}` in an argv are filled at run time and never written.
 */
export const STEPS = [
  {
    id: "rules",
    part: 1,
    checks: ["rules-list"],
    evidence: "rules-list-live.txt",
    actions: [
      { kind: "cmd", argv: ["rules", "list"], expect: [/YOUR RULES/, /all {5}handoff {12}any/] },
      {
        kind: "cmd",
        argv: ["rules", "add", "lead", "search_history", "prohibit", "--exact", "query=livecheck"],
        expect: [/^added: lead search_history \(query = livecheck\) -> prohibit$/m],
      },
      { kind: "cmd", argv: ["rules", "list"], expect: [/query = livecheck/] },
      {
        kind: "cmd",
        argv: ["rules", "remove", "lead", "search_history", "--exact", "query=livecheck"],
        expect: [/^removed: lead search_history \(query = livecheck\) -> prohibit$/m],
      },
    ],
  },
  {
    id: "usage",
    part: 1,
    checks: ["usage-line"],
    evidence: "usage-line-live.txt",
    actions: [
      { kind: "open", expect: [CONTRACT.usage] },
      {
        kind: "chat",
        say: "Say hello in one short sentence.",
        plainer: ["Reply with the word hello."],
        expect: [CONTRACT.usage],
        script: { text: "Hello." },
      },
    ],
  },
  {
    id: "c1",
    part: 1,
    checks: ["charter-1"],
    evidence: "charter-part1.txt",
    actions: [
      {
        kind: "cmd",
        argv: ["rules", "add", "lead", "handoff", "ask-first"],
        expect: [/^added: lead handoff \(any\) -> ask first$/m],
      },
      { kind: "cmd", argv: ["rules", "list"], expect: [/lead {4}handoff {12}any {28}ask first/] },
    ],
  },
  {
    id: "c2",
    part: 1,
    checks: ["held-call", "cli-text", "charter-2"],
    evidence: "held-call-live.txt",
    actions: [
      {
        kind: "chat",
        say: `Please hand off to the research specialist with this brief: ${RESEARCH_BRIEF}`,
        plainer: [`Use the handoff tool: specialist research, brief "${RESEARCH_BRIEF}"`],
        expect: [CONTRACT.held, CONTRACT.heldYourRule, /\/always \d+ +allow always/],
        script: handoffScript("research", RESEARCH_BRIEF),
      },
    ],
  },
  {
    id: "c3",
    part: 1,
    checks: ["held-call", "cli-text", "charter-3"],
    evidence: "held-call-live.txt",
    actions: [
      { kind: "answer", choice: "always", expect: [CONTRACT.allowedAlways] },
      { kind: "pause", ms: 5_000 },
      {
        kind: "cmd",
        argv: ["rules", "list"],
        expect: [/lead {4}handoff {12}specialist = research {10}permit/, /added by allow always/],
      },
      { kind: "cmd", argv: ["activity"], expect: [/handoff -> research {6}allowed {7}person/] },
    ],
  },
  {
    id: "c4",
    part: 1,
    checks: ["charter-4"],
    evidence: "charter-part1.txt",
    actions: [
      {
        kind: "chat",
        say: `Hand off to the research specialist again with this brief: ${RESEARCH_BRIEF}`,
        plainer: [`Use the handoff tool: specialist research, brief "${RESEARCH_BRIEF}"`],
        expect: [CONTRACT.usage],
        reject: [CONTRACT.held],
        script: handoffScript("research", RESEARCH_BRIEF),
      },
      { kind: "pause", ms: 5_000 },
      { kind: "cmd", argv: ["activity"], expect: [/handoff -> research {6}allowed {7}rule/] },
    ],
  },
  {
    id: "c5",
    part: 1,
    checks: ["charter-5"],
    evidence: "charter-part1.txt",
    actions: [
      {
        kind: "cmd",
        argv: [
          "rules",
          "add",
          "all",
          "handoff",
          "ask-first",
          "--exact",
          "specialist=developer",
          "--owner",
          "--person",
          "{person}",
        ],
        expect: [/^added: all handoff \(specialist = developer\) -> ask first$/m],
      },
      {
        kind: "chat",
        say: `Please hand off to the developer specialist with this brief: ${DEVELOPER_BRIEF}`,
        plainer: [`Use the handoff tool: specialist developer, brief "${DEVELOPER_BRIEF}"`],
        expect: [CONTRACT.held, CONTRACT.heldOwnerRule, CONTRACT.alwaysNotOffered],
        script: handoffScript("developer", DEVELOPER_BRIEF),
      },
      { kind: "answer", choice: "allow", expect: [CONTRACT.allowedOnce] },
    ],
  },
  {
    id: "c6",
    part: 1,
    checks: ["charter-6"],
    evidence: "charter-part1.txt",
    actions: [
      {
        kind: "cmd",
        argv: ["rules", "add", "lead", "search_history", "prohibit", "--exact", "query=bank"],
        expect: [/^added: lead search_history \(query = bank\) -> prohibit$/m],
      },
      {
        kind: "chat",
        say: "Use the search_history tool with the query bank, exactly that one word.",
        plainer: ['Call search_history with query "bank".'],
        expect: [CONTRACT.usage],
        script: { tool: "search_history", args: { query: "bank" } },
      },
      { kind: "cmd", argv: ["activity"], expect: [/search_history {11}refused {7}rule/] },
    ],
  },
  {
    id: "c7",
    part: 1,
    checks: ["charter-7"],
    evidence: "charter-part1.txt",
    actions: [
      {
        kind: "chat",
        say: "Set a reminder for tomorrow at 09:00 with the text: check card 4111 1111 1111 1111 expiry.",
        plainer: [
          'Use the set_reminder tool for tomorrow 09:00 with the text "check card 4111 1111 1111 1111 expiry".',
        ],
        expect: [CONTRACT.usage],
        script: {
          tool: "set_reminder",
          args: { at: "tomorrow 09:00", text: "check card 4111 1111 1111 1111 expiry" },
        },
      },
      { kind: "pause", ms: 5_000 },
      { kind: "cmd", argv: ["activity"], expect: [/set_reminder +\S.* reviewer /] },
    ],
  },
  {
    id: "c8",
    part: 1,
    checks: ["secret-grants", "secret-broker", "cli-text", "charter-8"],
    evidence: "secrets-live.txt",
    actions: [
      {
        kind: "stdin",
        value: "testSecret",
        argv: ["secrets", "add", "--person", "{person}", "live-test-secret"],
        expect: [CONTRACT.stored],
      },
      {
        kind: "stdin",
        value: "brokerToken",
        argv: [
          "secrets",
          "add",
          "--person",
          "{person}",
          "health-test",
          "--broker",
          "health",
          "--url",
          "{fakeTarget}",
          "--header",
          "authorization",
        ],
        expect: [CONTRACT.stored, /used only through the broker/],
      },
      {
        kind: "cmd",
        argv: [
          "secrets",
          "allowlist",
          "--person",
          "{person}",
          "add",
          "live-test-secret",
          "research",
        ],
        expect: [/\[ allowed \]/],
      },
      {
        kind: "cmd",
        argv: ["secrets", "allowlist", "--person", "{person}", "add", "health-test", "health"],
        expect: [/\[ allowed \]/],
      },
      {
        kind: "cmd",
        argv: ["secrets", "grant", "live-test-secret", "research"],
        expect: [CONTRACT.granted],
      },
      {
        kind: "cmd",
        argv: ["secrets", "grant", "health-test", "health"],
        expect: [CONTRACT.granted],
      },
      {
        kind: "chat",
        say: `Hand off to the research specialist with this brief: ${SECRET_BRIEF}`,
        plainer: [`Use the handoff tool: specialist research, brief "${SECRET_BRIEF}"`],
        expect: [CONTRACT.followupResearch],
        timeoutMs: FOLLOWUP_MS,
        script: handoffScript("research", SECRET_BRIEF, {
          tool: "secret_get",
          args: { name: "live-test-secret" },
        }),
      },
      {
        kind: "chat",
        say: "Use the secret_get tool yourself to read the secret named live-test-secret.",
        plainer: ['Call secret_get with name "live-test-secret".'],
        expect: [CONTRACT.usage],
        script: { tool: "secret_get", args: { name: "live-test-secret" } },
      },
      // The member's own ask-first rule holds a hand-off to the health specialist (allow always
      // added a permit for research only): allowed once, then the brokered call runs.
      {
        kind: "chat",
        say: `Hand off to the health specialist with this brief: ${BROKER_BRIEF}`,
        plainer: [`Use the handoff tool: specialist health, brief "${BROKER_BRIEF}"`],
        expect: [CONTRACT.held, CONTRACT.heldYourRule],
        script: handoffScript("health", BROKER_BRIEF, {
          tool: "broker_call",
          args: { secret: "health-test", method: "GET", path: "/v1/ping" },
        }),
      },
      {
        kind: "answer",
        choice: "allow",
        expect: [CONTRACT.allowedOnce, CONTRACT.followupHealth],
        timeoutMs: FOLLOWUP_MS,
      },
      {
        kind: "cmd",
        argv: ["activity"],
        expect: [
          /lead {7}secret live-test-secret +refused +secrets/,
          /research +secret_get +allowed/,
          /health +broker_call +allowed/,
        ],
      },
    ],
  },
  {
    id: "c9",
    part: 1,
    checks: ["limit-notices", "usage-line", "cli-text", "charter-9"],
    evidence: "cost-live.txt",
    actions: [
      { kind: "limit", to: "test", expect: [/monthly limit is now \$1\.00/] },
      { kind: "limit", to: "place-80", expect: [/monthly limit is now/] },
      {
        kind: "chat",
        say: "Tell me one short fact about trains.",
        plainer: ["Name one famous train."],
        expect: [CONTRACT.warn],
        repeat: 6,
        script: { text: "The first public railway opened in 1825." },
      },
      { kind: "limit", to: "below", expect: [/monthly limit is now/] },
      {
        kind: "chat",
        say: "Tell me one more short fact about trains.",
        plainer: ["Name one more famous train."],
        expect: [CONTRACT.over],
        script: { text: "Steam engines burned coal." },
      },
      {
        kind: "chat",
        say: `Hand off to the research specialist with this brief: ${RESEARCH_BRIEF}`,
        plainer: [`Use the handoff tool: specialist research, brief "${RESEARCH_BRIEF}"`],
        expect: [CONTRACT.usage],
        script: handoffScript("research", RESEARCH_BRIEF),
      },
      {
        kind: "cmd",
        argv: ["cost"],
        expect: [/BY LAYER/, /agent model/, /decision model/, /reviewer/],
      },
    ],
  },
  {
    id: "activity",
    part: 1,
    checks: ["activity"],
    evidence: "activity-live.txt",
    actions: [
      {
        kind: "cmd",
        argv: ["activity"],
        expect: [/^ACTIVITY {2}/m, /TIME {3}AGENT/, /held {10}rule/, /\[ total: \$/],
      },
    ],
  },
  {
    id: "c10-hold",
    part: 1,
    checks: ["charter-10"],
    evidence: "charter-part1.txt",
    actions: [
      {
        kind: "chat",
        say: `Please hand off to the developer specialist with this brief: ${DEVELOPER_BRIEF}`,
        plainer: [`Use the handoff tool: specialist developer, brief "${DEVELOPER_BRIEF}"`],
        expect: [CONTRACT.held, CONTRACT.heldOwnerRule],
        script: handoffScript("developer", DEVELOPER_BRIEF),
        keep: "pending",
      },
      { kind: "close" },
    ],
  },
  {
    id: "c10-after-restart",
    part: 2,
    checks: ["cli-text", "charter-10"],
    evidence: "charter-part2.txt",
    actions: [
      { kind: "limit", to: "restore", expect: [/monthly limit is now \$\d+\.\d\d/] },
      {
        kind: "cmd",
        argv: ["missed"],
        expect: [CONTRACT.heldCalls, /lead {2}handoff -> developer/],
      },
      { kind: "open", expect: [CONTRACT.usage] },
      { kind: "answer", choice: "allow", from: "pending", expect: [CONTRACT.allowedOnce] },
      { kind: "pause", ms: 30_000 },
      { kind: "close", reject: [CONTRACT.held] },
      { kind: "cmd", argv: ["missed"], reject: [/handoff -> developer/] },
    ],
  },
  {
    id: "cleanup",
    part: 2,
    checks: [],
    evidence: "cleanup.txt",
    cleanup: true,
    actions: [
      { kind: "limit", to: "restore", expect: [/monthly limit is now \$\d+\.\d\d/] },
      { kind: "cmd", argv: ["rules", "remove", "lead", "handoff"], optional: true },
      {
        kind: "cmd",
        argv: ["rules", "remove", "lead", "handoff", "--exact", "specialist=research"],
        optional: true,
      },
      {
        kind: "cmd",
        argv: ["rules", "remove", "lead", "search_history", "--exact", "query=bank"],
        optional: true,
      },
      {
        kind: "cmd",
        argv: [
          "rules",
          "remove",
          "all",
          "handoff",
          "--exact",
          "specialist=developer",
          "--owner",
          "--person",
          "{person}",
        ],
        optional: true,
      },
      { kind: "cmd", argv: ["mode", "show", "{person}"], expect: [/shadow/] },
    ],
  },
];

/** The steps of one part (cleanup runs at the end of part 2, and after a stop in either part). */
export const stepsOf = (part) => STEPS.filter((step) => step.part === part);

/** Every criterion the run serves, in first-seen order. */
export const ALL_CHECKS = [...new Set(STEPS.flatMap((step) => step.checks))];

/** The files whose presence show that the earlier live checks ran. */
export const CLEARING_FILES = [
  "rules-list-live.txt",
  "held-call-live.txt",
  "usage-line-live.txt",
  "activity-live.txt",
  "secrets-live.txt",
];

/** `argv` with `{person}` and `{fakeTarget}` filled from `context`. Pure. */
export function fillArgv(argv, context) {
  return argv.map((word) =>
    word === "{person}" ? context.person : word === "{fakeTarget}" ? context.fakeTarget : word,
  );
}

/** Which `expect` patterns are missing from `text`, and which `reject` patterns are in it. Pure. */
export function check(text, { expect = [], reject = [] } = {}) {
  return {
    missing: expect.filter((pattern) => !pattern.test(text)),
    present: reject.filter((pattern) => pattern.test(text)),
  };
}

/** The newest held call number in `text`, or undefined. Pure. */
export function newestHeld(text) {
  const all = [...text.matchAll(new RegExp(CONTRACT.held.source, "g"))];
  const last = all.at(-1);
  return last === undefined ? undefined : Number(last[1]);
}

/** The month's spend and limit from a `[ month: $X / $Y ]` line, or undefined. Pure. */
export function spendOf(text) {
  const found = /\[ month: \$(\d+\.\d\d) \/ \$(\d+\.\d\d) \]/.exec(text);
  return found === null ? undefined : { spend: Number(found[1]), limit: Number(found[2]) };
}

const cents = (usd) => Math.round(usd * 100);
const usd = (value) => (value / 100).toFixed(2);

/**
 * The limit, as a `secbot limits set` value, that puts the spend at a line:
 *   "place-80": the spend at about 75% of the limit, so a turn or two crosses 80%;
 *   "below":    one cent below the spend, so the 100% line is passed at once.
 * Never under one cent. Pure.
 */
export function placeLimit(spendUsd, line) {
  const spent = Math.max(0, cents(spendUsd));
  if (line === "place-80") return usd(Math.max(1, Math.ceil(spent / 0.75)));
  if (line === "below") return usd(Math.max(1, spent - 1));
  throw new Error(`unknown limit line ${line}`);
}

/**
 * The limit value of a "test" or "restore" action: "test" is $1.00, or undefined (skip) when the
 * spend already sits at 75% of it, so setting it would cross a line out of turn; "restore" is the
 * limit the run found (`original`), $25.00 when it found none. Pure.
 */
export function fixedLimit(to, { spendUsd = 0, original = DEFAULT_LIMIT_USD } = {}) {
  if (to === "test") {
    return cents(spendUsd) < cents(TEST_LIMIT_USD) * 0.75 ? usd(cents(TEST_LIMIT_USD)) : undefined;
  }
  if (to === "restore") return usd(cents(original));
  throw new Error(`unknown limit ${to}`);
}

/** The nearest-rank percentile of `values`, or null for none. Pure. */
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** True when the month's spend rose by more than `maxUsd` since the run began. Pure. */
export const overSpend = (startUsd, nowUsd, maxUsd = DEFAULT_MAX_USD) =>
  nowUsd !== undefined && startUsd !== undefined && nowUsd - startUsd > maxUsd;

/**
 * `text` with every private value replaced by its placeholder `<name>`: the value itself, and for a
 * URL its origin and its host name too (longest first, so a URL is replaced whole). Values shorter
 * than 4 characters are ignored. Pure.
 */
export function scrub(text, values) {
  const pairs = [];
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.length < 4) continue;
    pairs.push([value, `<${name}>`]);
    try {
      const url = new URL(value);
      if (url.hostname !== "") {
        pairs.push([url.origin, `<${name}>`]);
        if (url.hostname.length >= 4) pairs.push([url.hostname, `<${name}-host>`]);
      }
    } catch {
      // not a URL
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [value, placeholder] of pairs) out = out.split(value).join(placeholder);
  return out;
}

/** The private values (or their host names) still in `text`, by name. Pure. */
export function literalHits(text, values) {
  const hits = [];
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.length < 4) continue;
    if (text.includes(value)) hits.push(name);
    try {
      const host = new URL(value).hostname;
      if (host.length >= 4 && text.includes(host)) hits.push(`${name}-host`);
    } catch {
      // not a URL
    }
  }
  return [...new Set(hits)];
}

/**
 * The run's report: one line per step (pass, fail with its last lines, or not run) and one per
 * criterion (pass when every step that serves it passed, fail when one failed, not run when none
 * ran). `results` maps a step id to `{ status, detail?, last? }`. Pure.
 */
export function buildReport(results, steps = STEPS) {
  const lines = ["LIVE GUARD CHECK", "-".repeat(78), "STEP                 RESULT"];
  for (const step of steps) {
    const result = results[step.id] ?? { status: "not run" };
    lines.push(`${step.id.padEnd(21)}${result.status}${result.detail ? `: ${result.detail}` : ""}`);
    if (result.status === "fail" && result.last) {
      for (const line of result.last.split("\n").slice(-5)) lines.push(`    ${line.slice(0, 74)}`);
    }
  }
  lines.push("", "CRITERION            RESULT");
  const checks = [...new Set(steps.flatMap((step) => step.checks))];
  for (const name of checks) {
    const statuses = steps
      .filter((step) => step.checks.includes(name))
      .map((step) => results[step.id]?.status ?? "not run");
    const status = statuses.includes("fail")
      ? "fail"
      : statuses.every((each) => each === "pass")
        ? "pass"
        : "not run";
    lines.push(`${name.padEnd(21)}${status}`);
  }
  return `${lines.join("\n")}\n`;
}
