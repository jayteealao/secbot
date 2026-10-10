// The live guard check rehearsed on the stand-in: the same steps, patterns, and step runner as the
// live run (scripts/live-guard-steps.mjs, scripts/live-guard.mjs), against the worker's routes, real
// person cells and harnesses, the secrets cell with the stand-in key custody and the test-cell fake
// health target, the stub Decisions API with the test cell's mark-threshold cap, the faux model
// scripted to make each step's tool call, the faux reviewer, and the incident stand-in. Commands
// run through the real `secbot` run(); the chat is the cell's real session over a stand-in socket
// pair, printed by the command line's own frame renderer, with answers through its answer path.
// The restart between the two parts is the stand-in reopen of the same storage. No outside call.
// With SECBOT_EVIDENCE_DIR set, the scrubbed transcripts and the report are written there.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { OpenCellOptions } from "@secbot/cell-harness";
import {
  addSpend,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  reviewerResponder,
  verdictJson,
} from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_ENV, incidentStub } from "../../cell-harness/test/outage-fixtures.ts";
import {
  routineAt,
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import { CellClient } from "../../cli/src/client.ts";
import { frameRenderer } from "../../cli/src/commands/chat.ts";
import { answerHeld, answerOf } from "../../cli/src/commands/held.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import conformanceWorker, { type ConformanceEnv } from "../src/conformance-entry.ts";
import type { SocketLike } from "../src/person-cell.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  workerFetch,
} from "./guard-setup.ts";

// The step list and runner are the live driver's own modules (plain .mjs, no type declarations).
interface Script {
  readonly text?: string;
  readonly tool?: string;
  readonly args?: Record<string, JsonValue>;
  readonly then?: { readonly tool: string; readonly args: Record<string, JsonValue> };
}
interface Action {
  readonly kind: string;
  readonly say?: string;
  readonly plainer?: readonly string[];
  readonly script?: Script;
}
interface Step {
  readonly id: string;
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
  stepsOf(part: number): Step[];
  buildReport(results: Record<string, StepResult>, steps?: readonly Step[]): string;
  spendOf(text: string): { spend: number; limit: number } | undefined;
  literalHits(text: string, values: Record<string, string>): string[];
  readonly CLEARING_FILES: readonly string[];
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
  checkModels(deps: unknown, person: string): Promise<string | undefined>;
  setTestModels(deps: unknown, person: string): Promise<{ problem?: string; text: string }>;
}
const scripts = new URL("../../../scripts/", import.meta.url);
const steps = (await import(new URL("live-guard-steps.mjs", scripts).href)) as StepsModule;
const driver = (await import(new URL("live-guard.mjs", scripts).href)) as DriverModule;

const here = dirname(fileURLToPath(import.meta.url));
const DECISIONS_KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)
const TEST_SECRET = "lt-rehearsal-secret-5e7d9c1a"; // gitleaks:allow (fake test secret)
const BROKER_TOKEN = "lb-rehearsal-token-2b4f6a8c0e1d"; // gitleaks:allow (fake test token)
/** What one chat turn costs on the stand-in (the faux model is free), so the limit lines cross. */
const TURN_USD = 0.04;
const CELL_URL = `http://${HOST}`;

/** The test cell's cap, read from its config, so the rehearsal runs with the value it deploys. */
async function testCellCaps(): Promise<string> {
  const text = await readFile(join(here, "..", "wrangler.conformance.jsonc"), "utf8");
  const config = JSON.parse(
    text
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  ) as { vars: Record<string, string> };
  return config.vars.SECBOT_MARK_THRESHOLD_CAPS ?? "";
}

const chatActions = steps.STEPS.flatMap((step) => step.actions).filter(
  (action) => action.kind === "chat",
);

/** The script of a chat line (or of one of its plainer retries). */
const scriptOf = (text: string) =>
  chatActions.find((action) => action.say === text || action.plainer?.includes(text))?.script;

/** A tool's arguments, with a reminder time made real (tomorrow, ISO 8601). */
const argsOf = (tool: string, args: Record<string, JsonValue>) =>
  tool === "set_reminder" ? { ...args, at: new Date(Date.now() + 86_400_000).toISOString() } : args;

/** The faux model: the lead makes each line's scripted call; a specialist makes its brief's call. */
function respond(request: FauxRequest) {
  if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("done")]);
  if (request.role === "lead") {
    const script = scriptOf(request.lastText.trim());
    if (script?.tool !== undefined && script.args !== undefined) {
      return fauxAssistantMessage([fauxToolCall(script.tool, argsOf(script.tool, script.args))], {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage([fauxText(script?.text ?? "ok")]);
  }
  const brief = chatActions
    .map((action) => action.script)
    .find(
      (script) =>
        script?.then !== undefined &&
        typeof script.args?.brief === "string" &&
        request.lastText.includes(script.args.brief),
    );
  if (brief?.then !== undefined) {
    return fauxAssistantMessage([fauxToolCall(brief.then.tool, brief.then.args)], {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage([fauxText("ok")]);
}

let dir: string;
let stub: StubOpenRouter;
let s: GuardSetup | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-live-rehearsal-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  stub = await startStubOpenRouter();
  stub.decision = routineAt(0.05);
});
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  await stub.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("the live guard check, rehearsed on the stand-in", () => {
  it("passes every step of both parts around a restart, with one alert per line and no secret in the evidence", async () => {
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation(() => {});
    }
    const { incidents, fetcher } = incidentStub();
    // The fake health target is the test-cell worker's own route, reached by the broker's fetch.
    const conformanceEnv = { CONFORMANCE: { idFromName: (n: string) => n, get: () => ({}) } };
    const setup = await guardSetup(undefined, {
      respond: reviewerResponder(() => verdictJson("allow", "an ordinary reminder"), respond),
      // No decision model given: the cell builds its own from its environment, the test cell's
      // mark-threshold cap included (decision undefined overrides the setup's passing default).
      guard: { holdMs: 3_600_000, decision: undefined } as unknown as OpenCellOptions["guard"],
      cellEnv: {
        ...ALERT_ENV,
        OPENROUTER_API_KEY: DECISIONS_KEY,
        OPENROUTER_BASE_URL: stub.origin,
        SECBOT_MARK_THRESHOLD_CAPS: await testCellCaps(),
      },
      fetch: fetcher,
      household: true,
      secrets: {
        fetch: (input, init) =>
          conformanceWorker.fetch(
            new Request(String(input), init),
            conformanceEnv as unknown as ConformanceEnv,
          ),
      },
      sockets: true,
    });
    s = setup;
    const environment = {
      env: { SECBOT_CONFIG_DIR: dir, SECBOT_CELL_URL: CELL_URL, SECBOT_OPERATOR_KEY: OPERATOR_KEY },
      home: dir,
    };
    const client = new CellClient(
      CELL_URL,
      { name: "laptop", person: "owner", key: KEY },
      workerFetch(setup),
    );

    const cli = async (argv: string[], { stdin }: { stdin?: string } = {}) => {
      let out = "";
      let err = "";
      const io: Io = {
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
        lines: async function* () {
          if (stdin !== undefined) yield stdin;
        },
      };
      const code = await run(argv, { environment, io, fetch: workerFetch(setup) });
      return { code, out, err };
    };

    // The chat: the cell's real session over a stand-in socket pair, printed by the CLI renderer.
    let text = "";
    const chatIo: Io = {
      stdout: (chunk) => {
        text += chunk;
      },
      stderr: (chunk) => {
        text += chunk;
      },
      lines: async function* () {},
    };
    let socket: (SocketLike & { closed: boolean }) | undefined;
    let renderer = frameRenderer(chatIo);
    let requestNo = 0;
    const person = () => {
      const cell = setup.cells.get("owner");
      if (cell === undefined) throw new Error("the owner cell is not open");
      return cell;
    };
    const chat = {
      isOpen: () => socket !== undefined && !socket.closed,
      text: () => text,
      async open() {
        renderer = frameRenderer(chatIo);
        const server = {
          closed: false,
          send(data: string) {
            if (!this.closed) renderer.handle(JSON.parse(data));
          },
          close() {
            this.closed = true;
          },
        };
        socket = server;
        vi.stubGlobal(
          "WebSocketPair",
          class {
            0 = { send() {}, close() {} };
            1 = server;
          },
        );
        // Node refuses a 101 Response, so the opening settles as a rejection after the frames.
        await workerFetch(setup)(`${CELL_URL}${client.path("/session")}`, {
          headers: client.headers,
        }).catch(() => undefined);
      },
      async send(line: string) {
        const kind = answerOf(line.trim());
        if (kind.kind === "answer") {
          renderer.print("");
          await answerHeld(client, chatIo, kind.choice, kind.number);
          return;
        }
        if (socket === undefined) throw new Error("no open chat");
        await person().webSocketMessage(
          socket,
          JSON.stringify({ type: "input", text: line, requestId: `rehearsal-${++requestNo}` }),
        );
        const harness = setup.harness("owner");
        await addSpend(harness, TURN_USD);
        harness.budget.watch.trigger();
        await harness.budget.watch.settled();
      },
      async close() {
        const current = socket;
        if (current === undefined) return;
        await person().webSocketClose(current, 1000);
        current.closed = true;
        socket = undefined;
      },
    };
    const deps = {
      cli,
      chat,
      scale: 0.05,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 1_500))),
    };
    // The secrets cell takes plain http targets only on loopback, so the fake target is https.
    const fakeTarget = `https://${HOST}/fake-target`;
    const values = {
      "cell-url": CELL_URL,
      "fake-target": fakeTarget,
      "device-key": KEY,
      "operator-key": OPERATOR_KEY,
      "test-secret": TEST_SECRET,
      "broker-token": BROKER_TOKEN,
    };
    const context = {
      person: "owner",
      fakeTarget,
      values: { ...values, testSecret: TEST_SECRET, brokerToken: BROKER_TOKEN },
    };
    // The models step first: the cell starts with the lead on Opus, and the check moves it to
    // Sonnet and the decision model to Jev; the charter refuses to start before that.
    expect((await cli(["mode", "decision", "owner", "clef"])).code).toBe(0);
    expect(await driver.checkModels(deps, "owner")).toBe(
      "an Opus model is set for lead; run live:guard -- models first",
    );
    const models = await driver.setTestModels(deps, "owner");
    expect(models.problem).toBeUndefined();
    expect(models.text).toContain("$ secbot model set lead anthropic/claude-sonnet-5.5");
    expect(models.text).toContain("$ secbot mode decision owner jev");
    expect(models.text).not.toMatch(/model set (household|developer|research|health|reviewer)/);
    expect(await driver.checkModels(deps, "owner")).toBeUndefined();
    const start = steps.spendOf((await cli(["cost"])).out);
    const state: Record<string, unknown> = {
      startSpend: start?.spend,
      originalLimit: start?.limit,
    };

    const part1 = await driver.executeSteps(steps.stepsOf(1), deps, context, state, 5);
    await setup.restart("owner");
    const part2 = await driver.executeSteps(steps.stepsOf(2), deps, context, state, 5);
    const results = { ...part1.results, ...part2.results };
    const report = steps.buildReport(results);
    const evidence: Record<string, string> = { "models-live.txt": models.text, ...part1.evidence };
    for (const [file, more] of Object.entries(part2.evidence)) {
      evidence[file] = `${evidence[file] ?? ""}${more}`;
    }
    const target = process.env.SECBOT_EVIDENCE_DIR;
    if (target !== undefined && target !== "") {
      for (const [file, body] of Object.entries(evidence)) {
        await driver.writeEvidence(target, file, body, values);
      }
      await driver.writeEvidence(target, "summary.md", report, values);
    }

    expect(
      Object.entries(results).filter(([, result]) => result.status !== "pass"),
      report,
    ).toEqual([]);
    expect(state.pendingHeld).toEqual(expect.any(Number));
    // The run leaves the test cell on Sonnet and Jev.
    expect(await driver.checkModels(deps, "owner")).toBeUndefined();
    // One owner alert at each line, on the stand-in alert channel.
    expect(incidents.map((incident) => incident.body.summary)).toEqual([
      "Secbot owner cell: 80% of the monthly limit",
      "Secbot owner cell: monthly limit reached",
    ]);
    // Every file that shows an earlier live check ran has content.
    for (const file of steps.CLEARING_FILES) expect(evidence[file], file).toMatch(/\S/);
    // No key, secret, or token in any transcript; printed lines fit 80 columns.
    const all = Object.values(evidence).join("\n");
    expect(
      steps.literalHits(all.replaceAll(CELL_URL, ""), {
        "device-key": KEY,
        "operator-key": OPERATOR_KEY,
        "test-secret": TEST_SECRET,
        "broker-token": BROKER_TOKEN,
      }),
    ).toEqual([]);
    const printed = all.split("\n").filter((line) => !/^(\$ secbot|> )/.test(line));
    expect(printed.filter((line) => line.length > 80)).toEqual([]);
  }, 180_000);
});
