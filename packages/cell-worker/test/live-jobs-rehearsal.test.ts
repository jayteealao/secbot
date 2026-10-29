// The live jobs check rehearsed on the stand-in: the same steps, patterns, and step runner as the
// live run (scripts/live-jobs-steps.mjs, scripts/live-guard.mjs), against the worker's routes, the
// owner's and the second person's real cells, and the household cell, with the test cell's lookup
// tools and fixture pages, the stub Decisions API with the stand-in gate, the faux model scripted
// to make each step's calls, and the incident stand-in. Commands run through the real `secbot`
// run() as the owner (with the operator key) and as the second person; each chat is the person's
// real session over a stand-in socket pair, printed by the command line's own frame renderer, with
// its join path. No outside call. With SECBOT_EVIDENCE_DIR set, the scrubbed transcripts and the
// report are written there.
import type { JsonValue } from "@earendil-works/chord";
import { createDecisionModels, LIVE_FIXTURE_PAGES } from "@secbot/cell-harness";
import {
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
} from "@secbot/cell-harness/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standInDecide } from "../../cell-harness/test/injection-fixtures.ts";
import { ALERT_ENV, incidentStub } from "../../cell-harness/test/outage-fixtures.ts";
import {
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import { HOST, KEY, OPERATOR_KEY } from "./guard-setup.ts";
import {
  type ChatSession,
  chatSession,
  SECOND_KEY,
  type SharedSetup,
  sharedSetup,
} from "./shared-setup.ts";

// The step list and runner are the live driver's own modules (plain .mjs, no type declarations).
interface Call {
  readonly tool: string;
  readonly args: Record<string, JsonValue>;
}
interface Action {
  readonly kind: string;
  readonly say?: string;
  readonly plainer?: readonly string[];
  readonly script?: { readonly calls?: readonly Call[]; readonly text?: string };
}
interface Step {
  readonly id: string;
  readonly evidence: string;
  readonly checks: readonly string[];
  readonly actions: readonly Action[];
}
interface StepResult {
  readonly status: string;
  readonly detail?: string;
}
interface Ran {
  readonly results: Record<string, StepResult>;
  readonly evidence: Record<string, string>;
}
interface StepsModule {
  readonly STEPS: readonly Step[];
  stepsOf(group: string): Step[];
  buildReport(results: Record<string, StepResult>, steps?: readonly Step[]): string;
}
interface GuardStepsModule {
  literalHits(text: string, values: Record<string, string>): string[];
}
interface DriverModule {
  executeSteps(
    steps: readonly Step[],
    deps: unknown,
    context: unknown,
    state: Record<string, unknown>,
    maxUsd?: number,
  ): Promise<Ran>;
  writeEvidence(
    dir: string,
    name: string,
    text: string,
    values: Record<string, string>,
  ): Promise<void>;
}
const scripts = new URL("../../../scripts/", import.meta.url);
const steps = (await import(new URL("live-jobs-steps.mjs", scripts).href)) as StepsModule;
const guardSteps = (await import(
  new URL("live-guard-steps.mjs", scripts).href
)) as GuardStepsModule;
const driver = (await import(new URL("live-guard.mjs", scripts).href)) as DriverModule;

const DECISIONS_KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)
/** How long the lead waits before it acts on a paused job, so the board shows the pause. */
const PAUSE_THINK_MS = 1_500;

const chatActions = steps.STEPS.flatMap((step) => step.actions).filter(
  (action) => action.kind === "chat",
);

/** The script of a chat line (or of one of its plainer retries). */
const scriptOf = (text: string) =>
  chatActions.find((action) => action.say === text || action.plainer?.includes(text))?.script;

const calls = (list: readonly Call[]) =>
  fauxAssistantMessage(
    list.map((call) => fauxToolCall(call.tool, call.args)),
    { stopReason: "toolUse" },
  );

/**
 * The faux model as the steps script it: the lead makes each line's calls, pulls a finished job,
 * and on each pause of the failing job raises its effort, then restarts it, then raises its tier
 * (which ends it with a question for the person); a job (or the household's) makes its brief's one
 * lookup and answers what it found, and calls the failing lookup again after each failure.
 */
function jobsResponder(fallback: Responder): Responder {
  const pauses = new Map<number, number>();
  return async (request: FauxRequest) => {
    const text = request.lastText;
    const afterTool = request.last?.role === "toolResult";
    if (request.role === "lead" && !afterTool) {
      const script = scriptOf(text.trim());
      if (script?.calls !== undefined) return calls(script.calls);
      if (script?.text !== undefined) return fauxAssistantMessage([fauxText(script.text)]);
      const pull = /^(?:Job (\d+) has finished|Use the job_result tool for job (\d+))/.exec(text);
      if (pull !== null) {
        return calls([{ tool: "job_result", args: { job: Number(pull[1] ?? pull[2]) } }]);
      }
      const paused = /^\[job (\d+) paused: same step failed/.exec(text);
      if (paused !== null) {
        const job = Number(paused[1]);
        const seen = (pauses.get(job) ?? 0) + 1;
        pauses.set(job, seen);
        await new Promise((done) => setTimeout(done, PAUSE_THINK_MS));
        if (seen === 1) return calls([{ tool: "set_job", args: { job, effort: "high" } }]);
        if (seen === 2) {
          return calls([{ tool: "restart_job", args: { job, note: "the same id again" } }]);
        }
        return calls([{ tool: "set_job", args: { job, tier: "frontier" } }]);
      }
    }
    if (request.role !== "lead") {
      if (afterTool) {
        if (text.includes("Lookup failed")) {
          return calls([{ tool: "fixture_lookup", args: { id: "lisbon-7" } }]);
        }
        const found = /Lookup result for [^\n]*/.exec(text);
        if (found !== null) return fauxAssistantMessage([fauxText(found[0])]);
      } else if (text.includes("it is resumed now")) {
        return calls([{ tool: "fixture_slow_lookup", args: { topic: "resumed" } }]);
      } else {
        const slow = /fixture_slow_lookup once with topic ([a-z0-9-]+),/.exec(text);
        if (slow !== null) {
          return calls([{ tool: "fixture_slow_lookup", args: { topic: slow[1] ?? "" } }]);
        }
        if (text.includes("fixture_lookup with id lisbon-7")) {
          return calls([{ tool: "fixture_lookup", args: { id: "lisbon-7" } }]);
        }
        if (text.includes("fixture page named injected")) {
          return calls([{ tool: "read_fixture_page", args: { page: "injected" } }]);
        }
      }
    }
    return fallback(request);
  };
}

/**
 * A person's chat as the step runner drives it. The runner writes the person's own lines into the
 * transcript itself, so the session's echo of them is left out.
 */
function chatOf(session: ChatSession) {
  let open = false;
  return {
    isOpen: () => open,
    text: () =>
      `${session.out()}${session.err()}`
        .split("\n")
        .filter((line) => !line.startsWith("> "))
        .join("\n"),
    async open() {
      await session.open();
      open = true;
    },
    send: (line: string) => session.say(line),
    async close() {
      await session.close();
      open = false;
    },
  };
}

let stub: StubOpenRouter | undefined;
let s: SharedSetup | undefined;
afterEach(async () => {
  if (s !== undefined) await s.close();
  s = undefined;
  await stub?.close();
  stub = undefined;
  vi.restoreAllMocks();
});

describe("the live jobs check, rehearsed on the stand-in", () => {
  it("passes every step as the owner, the second person, and the operator", async () => {
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation(() => {});
    }
    stub = await startStubOpenRouter();
    stub.decide = standInDecide;
    const { incidents, fetcher } = incidentStub();
    // The slow lookup's wait, read at each call: short while the research job must finish, long
    // while jobs must still be running for a stop.
    const slow = { slowMs: 3_000 };
    const setup = await sharedSetup({
      fleets: 1,
      wrap: jobsResponder,
      more: {
        guard: { decision: createDecisionModels({ apiKey: DECISIONS_KEY, baseUrl: stub.origin }) },
        cellEnv: ALERT_ENV,
        fetch: fetcher,
        fixturePages: LIVE_FIXTURE_PAGES,
        fixtureTools: slow,
        householdFixtures: slow,
      },
    });
    s = setup;
    const deps = {
      cli: (argv: string[]) => setup.secbotAs("owner", argv, { operator: true }),
      chat: chatOf(chatSession(setup, "owner")),
      cliAs: { second: (argv: string[]) => setup.secbotAs("second", argv) },
      chatAs: { second: chatOf(chatSession(setup, "second")) },
      scale: 0.05,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 1_500))),
    };
    const values = {
      "cell-url": `http://${HOST}`,
      "device-key": KEY,
      "second-device-key": SECOND_KEY,
      "operator-key": OPERATOR_KEY,
    };
    const context = { person: "owner", values };
    const state: Record<string, unknown> = {};
    const run = (list: readonly Step[]) => driver.executeSteps(list, deps, context, state, 10);
    const charter = steps.stepsOf("charter");

    const first = await run(charter.slice(0, 3));
    slow.slowMs = 120_000;
    // The person cells exchange shared jobs with the household on their own schedule; the
    // stand-in syncs both every half second.
    const syncs = setInterval(() => {
      for (const person of ["owner", "second"]) {
        try {
          void setup
            .harness(person)
            .syncShared()
            .catch(() => undefined);
        } catch {
          // the cell is not open yet
        }
      }
    }, 500);
    const rest = await run([...charter.slice(3), ...steps.stepsOf("stop-all")]).finally(() =>
      clearInterval(syncs),
    );

    // The capacity line: the owner's measured number at 1, two slow jobs, the board's line.
    const put = await setup.fetchFor("owner")(`http://${HOST}/ops/capacity?cell=owner`, {
      method: "PUT",
      headers: { "x-secbot-operator": OPERATOR_KEY, "content-type": "application/json" },
      body: JSON.stringify({ measured: 1, at: Date.UTC(2026, 9, 29) }),
    });
    expect(put.status).toBe(200);
    const c6 = charter.find((step) => step.id === "c6");
    if (c6 === undefined) throw new Error("no c6 step");
    const starts = await run([
      { ...c6, id: "k0", evidence: "capacity-line.txt", actions: c6.actions.slice(0, 3) },
    ]);
    const line = await run(steps.stepsOf("capacity-line"));
    await setup.secbotAs("owner", ["stop"]);

    const results = { ...first.results, ...rest.results, ...starts.results, ...line.results };
    const evidence: Record<string, string> = {};
    for (const ran of [first, rest, starts, line]) {
      for (const [file, more] of Object.entries(ran.evidence)) {
        evidence[file] = `${evidence[file] ?? ""}${more}`;
      }
    }
    const report = steps.buildReport(results, steps.STEPS);
    const target = process.env.SECBOT_EVIDENCE_DIR;
    if (target !== undefined && target !== "") {
      for (const [file, body] of Object.entries(evidence)) {
        await driver.writeEvidence(target, file, body, values);
      }
      await driver.writeEvidence(target, "summary.md", report, values);
    }

    expect(
      Object.entries(results).filter(([, result]) => result.status !== "pass"),
      `${report}\n${Object.values(evidence).join("\n")}`,
    ).toEqual([]);
    // The kept numbers: the research job, the failing job's question, the shared job.
    expect(state.jobs).toMatchObject({
      research: expect.any(Number),
      asked: expect.any(Number),
      stopped: expect.any(Number),
      shared: expect.any(Number),
    });
    // One owner alert for the capacity line.
    expect(
      incidents
        .map((incident) => incident.body.summary)
        .filter((each) => /jobs at once/.test(String(each))),
    ).toEqual(["Secbot owner cell: 2 jobs at once, measured at 1"]);
    // No key in any transcript.
    const all = Object.values(evidence).join("\n");
    expect(
      guardSteps.literalHits(all.replaceAll(`http://${HOST}`, ""), {
        "device-key": KEY,
        "second-device-key": SECOND_KEY,
        "operator-key": OPERATOR_KEY,
      }),
    ).toEqual([]);
    for (const file of [1, 2, 3, 4, 5, 6].map((n) => `charter-${n}.txt`)) {
      expect(evidence[file], file).toMatch(/\S/);
    }
    expect(evidence["stop-all.txt"]).toMatch(/\(as operator\) \$ secbot stop --all/);
  }, 240_000);
});
