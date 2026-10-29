// The live jobs check on the test cell, as data: the charter scenario's job steps, the stop of
// every cell, and the capacity line, each with the command lines or chat lines to send, the output
// each must show (the contract lines of the secbot command line), the evidence file, and the
// criteria it serves. Both the live driver (scripts/live-jobs.mjs) and the stand-in rehearsal
// (packages/cell-worker/test/live-jobs-rehearsal.test.ts) run these same steps with the live
// guard check's step runner (scripts/live-guard.mjs).
//
// The jobs run on the test cell's lookup tools (SECBOT_TEST_FIXTURES): `fixture_slow_lookup`
// keeps a job running long enough to steer, stop, and count it; `fixture_lookup` always fails, so
// a job pauses on the same failure; `read_fixture_page` reads the page that gives the agent orders.
//
// Node standard library only. Every helper here is pure.
import { CONTRACT as GUARD_CONTRACT, keptNumber } from "./live-guard-steps.mjs";

export { keptNumber };

/** The run stops itself when the month's spend rises by more than this. */
export const DEFAULT_MAX_USD = 10;
/** How long a board check waits for a job to reach the state it expects. */
export const JOB_WAIT_MS = 300_000;
/** How long a chat waits for a job's question line after its last failure. */
export const QUESTION_WAIT_MS = 600_000;

/** A board row of any job whose status is `status` (the row's last column). */
const row = (status) => new RegExp(`^(\\d+) +\\S.* ${status}$`, "m");
/** A reason line under a row, at the board's reason indent. */
const reason = (text) => new RegExp(`^ {6}${text}$`, "m");
/** A cell's line in the owner's stop, padded to ten columns. */
const cellLine = (cell, what) => new RegExp(`^ {2}${cell} {${10 - cell.length}}${what}`, "m");

/** The contract lines of the command line, as patterns. */
export const CONTRACT = {
  usage: GUARD_CONTRACT.usage,
  boardHeader:
    /^JOBS {2}.+ {2}\[ live: \d+ \] \[ (?:results waiting|waiting results): \d+ \] {2}\[ [^\]]+ \]$/m,
  waitingOne: /\[ results waiting: 1 \]/,
  waitingNone: /\[ results waiting: 0 \]/,
  running: row("running"),
  twoRunning: /^\d+ +\S.* running$[\s\S]*^\d+ +\S.* running$/m,
  paused: row("paused"),
  loopReason: reason("same step failed 3 times; the lead decides what next"),
  asks: /\[ job (\d+) asks \] answer with \/answer \d+ <text>/,
  failed: row("failed"),
  exhausted: reason("raise and restart used; the lead asked you"),
  blocked: row("blocked"),
  pageReason: reason("a page tried to give the agent orders; nothing from it was used"),
  stopped: /^\[ stopped \] \d+ jobs?(?: and the lead's current turn)?\. Their state is kept\.$/m,
  stoppedRow: row("stopped"),
  stoppedByYou: reason("stopped by you at \\d\\d:\\d\\d; secbot jobs restart (\\d+)"),
  stoppedByOwner: reason("stopped by the owner at \\d\\d:\\d\\d; secbot jobs restart \\d+"),
  restarted: /^\[ restarted \] #\d+ .+, from its kept brief and transcript$/m,
  stopAll: /^\[ stopped \] household: \d+ jobs? and \d+ lead turns?\. Their state is kept\.$/m,
  stopAllOwner: cellLine("owner", "[1-9]\\d* jobs?"),
  stopAllSecond: cellLine("second", "[1-9]\\d* jobs?"),
  stopAllHousehold: cellLine("household", "[1-9]\\d* shared jobs?"),
  sharedOffer:
    /\[ job (\d+) shared \] \/join \d+ to share the cost, \/decline \d+ to leave it to \S+/,
  joined: /\[ joined \] #\d+ .+; (?:you pay half|you pay all|\S+ pays all)/,
  capacity:
    /^\[ (\d+) jobs at once; this cell was measured at (\d+) on \d{1,2} [A-Z][a-z]{2} \] nothing is held back$/m,
};

/** The briefs the jobs get; the rehearsal's stand-in job reads them to make the same calls. */
export const BRIEFS = {
  research:
    "Call fixture_slow_lookup once with topic trains-to-leeds, then answer its text in one line.",
  failing:
    "Call fixture_lookup with id lisbon-7. If it fails, call it again with the same id until it works.",
  injected: "Read the fixture page named injected with read_fixture_page and summarise it.",
  slow: (topic) =>
    `Call fixture_slow_lookup once with topic ${topic}, then answer its text in one line.`,
};

/** A chat line that asks the lead to start one job, and its plainer retry. */
const startLine = (title, brief) =>
  `Start a research job now with the start_job tool: template research, title "${title}", brief "${brief}". Reply in one short line.`;
const startPlainer = (title, brief) =>
  `Use the start_job tool: template research, title "${title}", brief "${brief}"`;
const startScript = (title, brief) => ({
  calls: [{ tool: "start_job", args: { title, brief, template: "research" } }],
});

/** One chat action that starts a job, waiting for the turn's usage line. */
const startJob = (title, brief, extra = {}) => ({
  kind: "chat",
  say: startLine(title, brief),
  plainer: [startPlainer(title, brief)],
  expect: [CONTRACT.usage],
  script: startScript(title, brief),
  ...extra,
});

/** `secbot jobs`, run again every 5 s until its patterns show or the wait ends. */
const board = (expect, extra = {}) => ({
  kind: "cmd",
  argv: ["jobs"],
  expect: [CONTRACT.boardHeader, ...expect],
  waitMs: JOB_WAIT_MS,
  ...extra,
});

/**
 * One step: `actions` run in order (the live guard check's kinds; see live-guard-steps.mjs), plus:
 *   watch   wait for `expect` in what a chat printed since the step began, sending nothing
 *   keep    on a cmd, chat, or watch: `{ name, from }` keeps the job number `from` (its first
 *           group, newest match) as `{job:<name>}` for later argv words and chat lines
 *   as      "second" or "operator": the action runs on that person's command line or chat
 */
export const STEPS = [
  {
    id: "c1",
    checks: ["research-job"],
    evidence: "charter-1.txt",
    actions: [
      { kind: "open", expect: [CONTRACT.usage] },
      startJob("train options", BRIEFS.research),
      board([CONTRACT.running], { keep: { name: "research", from: CONTRACT.running } }),
    ],
  },
  {
    id: "c2",
    checks: ["steer-mid-job"],
    evidence: "charter-2.txt",
    actions: [
      {
        kind: "chat",
        say: "While that job runs: what is 12 times 12? Answer with the number only.",
        plainer: ["Reply with the number 144."],
        expect: [/\b144\b/, CONTRACT.usage],
        script: { text: "144" },
      },
      board([CONTRACT.running, CONTRACT.waitingNone], { waitMs: undefined }),
    ],
  },
  {
    id: "c3",
    checks: ["result-pulled"],
    evidence: "charter-3.txt",
    actions: [
      board([CONTRACT.waitingOne]),
      {
        kind: "chat",
        say: "Job {job:research} has finished. Pull its result with job_result and tell me what it found in one line.",
        plainer: ["Use the job_result tool for job {job:research}, then tell me its result."],
        expect: [/three options found/i, CONTRACT.usage],
        script: { pull: "research" },
      },
      board([CONTRACT.waitingNone]),
    ],
  },
  {
    id: "c4",
    checks: ["escalation"],
    evidence: "charter-4.txt",
    actions: [
      startJob("lisbon lookup", BRIEFS.failing),
      board([CONTRACT.paused, CONTRACT.loopReason]),
      {
        kind: "watch",
        expect: [CONTRACT.asks],
        timeoutMs: QUESTION_WAIT_MS,
        keep: { name: "asked", from: CONTRACT.asks },
      },
      board([CONTRACT.failed, CONTRACT.exhausted]),
    ],
  },
  {
    id: "c5",
    checks: ["page-blocked"],
    evidence: "charter-5.txt",
    actions: [
      startJob("gym prices", BRIEFS.injected),
      board([CONTRACT.blocked, CONTRACT.pageReason]),
    ],
  },
  {
    id: "c6",
    checks: ["stop-restart"],
    evidence: "charter-6.txt",
    actions: [
      startJob("slow one", BRIEFS.slow("slow-one")),
      startJob("slow two", BRIEFS.slow("slow-two")),
      board([CONTRACT.twoRunning]),
      { kind: "cmd", argv: ["stop"], expect: [CONTRACT.stopped] },
      board([CONTRACT.stoppedRow, CONTRACT.stoppedByYou], {
        waitMs: undefined,
        keep: { name: "stopped", from: CONTRACT.stoppedByYou },
      }),
      { kind: "cmd", argv: ["jobs", "restart", "{job:stopped}"], expect: [CONTRACT.restarted] },
      board([CONTRACT.running]),
    ],
  },
  {
    id: "s7",
    checks: ["stop-all"],
    evidence: "stop-all.txt",
    actions: [
      startJob("owner slow", BRIEFS.slow("owner-slow")),
      { kind: "open", as: "second", expect: [CONTRACT.usage] },
      startJob("second slow", BRIEFS.slow("second-slow"), { as: "second" }),
      {
        kind: "chat",
        say: `Propose a shared household job to second with the propose_shared_job tool: title "weekend plan", brief "${BRIEFS.slow("weekend-plan")}". Reply in one short line.`,
        plainer: [
          `Use the propose_shared_job tool: title "weekend plan", brief "${BRIEFS.slow("weekend-plan")}"`,
        ],
        expect: [CONTRACT.usage],
        script: {
          calls: [
            {
              tool: "propose_shared_job",
              args: { title: "weekend plan", brief: BRIEFS.slow("weekend-plan") },
            },
          ],
        },
      },
      {
        kind: "watch",
        as: "second",
        expect: [CONTRACT.sharedOffer],
        timeoutMs: JOB_WAIT_MS,
        keep: { name: "shared", from: CONTRACT.sharedOffer },
      },
      {
        kind: "chat",
        as: "second",
        say: "/join {job:shared}",
        expect: [CONTRACT.joined],
        timeoutMs: 60_000,
      },
      {
        kind: "cmd",
        as: "operator",
        argv: ["jobs", "--household"],
        expect: [CONTRACT.boardHeader, CONTRACT.running],
        waitMs: JOB_WAIT_MS,
      },
      board([CONTRACT.running], { as: "second" }),
      board([CONTRACT.running]),
      {
        kind: "cmd",
        as: "operator",
        argv: ["stop", "--all"],
        expect: [
          CONTRACT.stopAll,
          CONTRACT.stopAllOwner,
          CONTRACT.stopAllSecond,
          CONTRACT.stopAllHousehold,
        ],
      },
      board([CONTRACT.stoppedByOwner], { waitMs: undefined }),
      board([CONTRACT.stoppedByOwner], { waitMs: undefined, as: "second" }),
    ],
  },
  {
    id: "k1",
    checks: ["capacity-line"],
    evidence: "capacity-line.txt",
    actions: [board([CONTRACT.capacity], { waitMs: 60_000 })],
  },
];

/** The steps of one command: the charter's six, the stop of every cell, or the capacity line. */
export const stepsOf = (group) =>
  STEPS.filter((step) =>
    group === "charter"
      ? step.id.startsWith("c")
      : group === "stop-all"
        ? step.id === "s7"
        : step.id === "k1",
  );

/** Every criterion the steps serve. */
export const ALL_CHECKS = [...new Set(STEPS.flatMap((step) => step.checks))];

/**
 * The run's report: one line per step (pass, fail with its last lines, or not run) and one per
 * criterion (pass when every step that serves it passed, fail when one failed, not run when none
 * ran). Pure.
 */
export function buildReport(results, steps = STEPS) {
  const lines = ["LIVE JOBS CHECK", "-".repeat(78), "STEP                 RESULT"];
  for (const step of steps) {
    const result = results[step.id] ?? { status: "not run" };
    const line = `${step.id.padEnd(21)}${result.status}${result.detail ? `: ${result.detail}` : ""}`;
    lines.push(line.slice(0, 80));
    if (result.status === "fail" && result.last) {
      for (const each of result.last.split("\n").slice(-5)) lines.push(`    ${each.slice(0, 74)}`);
    }
  }
  lines.push("", "CRITERION            RESULT");
  for (const name of [...new Set(steps.flatMap((step) => step.checks))]) {
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
