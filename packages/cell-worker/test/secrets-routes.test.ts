// The secrets cell end to end on the stand-in (no network beyond 127.0.0.1): the real `secbot`
// command line against the worker's routes, two real person cells, and the secrets cell with a
// stand-in key custody, the faux model, the stub Decisions API, and a faux reviewer.
//
// - The owner adds a secret and allowlists it for research; the person grants it. A grant outside
//   the allowlist, for an agent not on the roster, of a missing secret, or of another person's
//   secret is refused on stderr with exit 1 (AC-39).
// - research reads the value; the lead and the household specialist are refused, and so is research
//   for a secret not granted to it. Each refusal is a `secrets`-layer row in `secbot activity`
//   (AC-38), and each logs one `secret.refused` line (AC-45).
// - A brokered health call reaches a local fake target with the token in its header and returns
//   the answer; no agent ever sees the token (AC-40).
// - The value and the token appear in no activity record, log line, held call's approval prompt,
//   decision-model request, or reviewer input (AC-42).
// With SECBOT_EVIDENCE_DIR set, each command's stdout, stderr, and exit code are written there.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { createDecisionModels } from "@secbot/cell-harness";
import {
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  isReviewerRequest,
  loggedEvents,
  reviewerResponder,
  until,
  verdictJson,
} from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  riskyAt,
  routineAt,
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { sha256Hex } from "../src/device-auth.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  scripted,
  workerFetch,
} from "./guard-setup.ts";

const DECISIONS_KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)
const SECOND_KEY = "second-phone-key-0123456789abcdef0123456789abcdef"; // gitleaks:allow (fake test key)
/** The test secret's value: plain words, so only the learned redaction values can catch it. */
const VALUE = "plum orchard lantern 4417";
const BROKER_TOKEN = "hb-test-token-7f3a9c2e1d4b8a6f"; // gitleaks:allow (fake test token)
const SPARE_VALUE = "spare value never granted";

let dir: string;
let stub: StubOpenRouter;
let target: Server;
let targetUrl: string;
let s: GuardSetup | undefined;
const targetSeen: { path: string; header: string | undefined }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-secrets-routes-"));
  await mkdir(join(dir, "second"), { recursive: true });
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
  await writeFile(
    join(dir, "second", "device.json"),
    JSON.stringify({ name: "phone", person: "second", key: SECOND_KEY }),
  );
  stub = await startStubOpenRouter();
  targetSeen.length = 0;
  // The health service stand-in: answers only with the token in its header, and echoes the token
  // back, so the test shows the secrets cell takes it out of the answer.
  target = createServer((request, response) => {
    const header = request.headers.authorization;
    targetSeen.push({ path: request.url ?? "", header });
    response.writeHead(header === BROKER_TOKEN ? 200 : 401, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ summary: "slept 7h 10m", echo: header ?? null }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  await stub.close();
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/**
 * The lead follows `CALL` lines (guard-setup's `scripted`); a specialist makes the one call its
 * brief names, with `$SECRET` standing for the value it read earlier through `secret_get`.
 */
function respond(request: FauxRequest) {
  if (request.role === "lead" || request.last?.role === "toolResult") return scripted(request);
  const found = /CALL (\S+) (\{.*\})/.exec(request.lastText);
  if (found === null) return fauxAssistantMessage([fauxText("ok")]);
  const args = JSON.parse((found[2] ?? "{}").replaceAll("$SECRET", VALUE)) as Record<
    string,
    JsonValue
  >;
  return fauxAssistantMessage([fauxToolCall(found[1] ?? "", args)], { stopReason: "toolUse" });
}

async function openSetup(): Promise<GuardSetup> {
  s = await guardSetup(undefined, {
    respond: reviewerResponder(() => verdictJson("allow", "an ordinary list change"), respond),
    guard: {
      decision: createDecisionModels({ apiKey: DECISIONS_KEY, baseUrl: stub.origin }),
      holdMs: 60_000,
    },
    household: true,
    secrets: true,
  });
  Object.assign(s.env, {
    SECBOT_DEVICE_KEYS: `laptop:owner:${await sha256Hex(KEY)}, phone:second:${await sha256Hex(SECOND_KEY)}`,
  });
  return s;
}

/** Runs `secbot <argv>` in process against the worker as the owner's or the second's device. */
async function secbot(
  setup: GuardSetup,
  who: { readonly person?: "owner" | "second"; readonly stdin?: readonly string[] },
  ...argv: string[]
) {
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
      yield* who.stdin ?? [];
    },
  };
  const config = who.person === "second" ? join(dir, "second") : dir;
  const env: Record<string, string> = {
    SECBOT_CONFIG_DIR: config,
    SECBOT_CELL_URL: `http://${HOST}`,
    SECBOT_OPERATOR_KEY: OPERATOR_KEY,
  };
  const code = await run(argv, {
    environment: { env, home: config },
    io,
    fetch: workerFetch(setup),
  });
  return { code, out, err };
}

/** Writes one command's output as evidence when SECBOT_EVIDENCE_DIR is set. */
async function evidence(
  name: string,
  argv: string,
  result: { code: number; out: string; err: string },
) {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(
    join(where, name),
    `$ secbot ${argv}\n${result.out}${result.err === "" ? "" : `[stderr]\n${result.err}`}[exit ${result.code}]\n`,
  );
}

let requestNo = 0;
async function leadSays(setup: GuardSetup, line: string) {
  await setup.cells.get("owner")?.submitInput("owner", line, `secrets-routes-${++requestNo}`);
}
const handoff = (specialist: string, call: string) =>
  `CALL handoff ${JSON.stringify({ specialist, brief: call })}`;

const RULE = "-".repeat(78);
const rowBody = (agent: string, tool: string, verdict: string, layer: string) =>
  `  ${agent.padEnd(11)}${tool.padEnd(25)}${verdict.padEnd(14)}${layer.padEnd(10)}`;

describe("secrets end to end on the stand-in", () => {
  it("grants inside the allowlist, gives only the granted agent the value, brokers a health call, and leaks nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const setup = await openSetup();
    stub.decision = routineAt(0.05);

    // The owner stores two secrets and a health broker secret, and allowlists them.
    const added = await secbot(
      setup,
      { stdin: [VALUE] },
      "secrets",
      "add",
      "--person",
      "owner",
      "test-secret",
    );
    await evidence("add.txt", "secrets add --person owner test-secret", added);
    expect(added).toEqual({
      code: 0,
      out: "[ stored ] test-secret for owner under key k1\n",
      err: "",
    });
    expect(
      (
        await secbot(
          setup,
          { stdin: [SPARE_VALUE] },
          "secrets",
          "add",
          "--person",
          "owner",
          "spare",
        )
      ).code,
    ).toBe(0);
    const broker = await secbot(
      setup,
      { stdin: [BROKER_TOKEN] },
      "secrets",
      "add",
      "--person",
      "owner",
      "health-test",
      "--broker",
      "health",
      "--url",
      targetUrl,
      "--header",
      "authorization",
    );
    expect(broker.out).toBe(
      "[ stored ] health-test for owner under key k1; used only through the broker\n",
    );
    const allowed = await secbot(
      setup,
      {},
      "secrets",
      "allowlist",
      "--person",
      "owner",
      "add",
      "test-secret",
      "research",
    );
    await evidence(
      "allowlist.txt",
      "secrets allowlist --person owner add test-secret research",
      allowed,
    );
    expect(allowed).toEqual({
      code: 0,
      out: "[ allowed ] owner test-secret -> research\n",
      err: "",
    });
    expect(
      (
        await secbot(
          setup,
          {},
          "secrets",
          "allowlist",
          "--person",
          "owner",
          "add",
          "health-test",
          "health",
        )
      ).code,
    ).toBe(0);

    // AC-39: the person grants inside the allowlist only.
    const refusals: [string[], { person?: "owner" | "second" }, string][] = [
      [
        ["test-secret", "household"],
        {},
        "test-secret is not in the owner's allowlist for household",
      ],
      [["test-secret", "builder"], {}, "no agent named builder"],
      [["other-secret", "research"], {}, "no secret named other-secret"],
      [["test-secret", "research"], { person: "second" }, "no secret named test-secret"],
    ];
    for (const [[secret = "", agent = ""], who, reason] of refusals) {
      const refused = await secbot(setup, who, "secrets", "grant", secret, agent);
      expect(refused).toEqual({ code: 1, out: "", err: `secbot: refused: ${reason}\n` });
    }
    await evidence(
      "grant-refused.txt",
      "secrets grant test-secret household",
      await secbot(setup, {}, "secrets", "grant", "test-secret", "household"),
    );
    const granted = await secbot(setup, {}, "secrets", "grant", "test-secret", "research");
    await evidence("grant.txt", "secrets grant test-secret research", granted);
    expect(granted).toEqual({ code: 0, out: "[ granted ] test-secret -> research\n", err: "" });
    expect((await secbot(setup, {}, "secrets", "grant", "health-test", "health")).out).toBe(
      "[ granted ] health-test -> health\n",
    );
    const listed = await secbot(setup, {}, "secrets", "list");
    await evidence("list.txt", "secrets list", listed);
    expect(listed.out.split("\n")).toEqual([
      "SECRETS  owner",
      RULE,
      "NAME              KIND         GRANTED TO",
      "health-test       health       health",
      "spare             secret       -",
      "test-secret       secret       research",
      "",
    ]);

    // AC-38: research reads the value; the lead, household, and research for "spare" are refused.
    const harness = setup.harness("owner");
    const sawValue = () =>
      setup.gateway.requests.some(
        (request) =>
          request.role === "research" &&
          request.last?.role === "toolResult" &&
          request.lastText.includes(VALUE),
      );
    await leadSays(setup, handoff("research", 'CALL secret_get {"name":"test-secret"}'));
    await until(sawValue);
    await leadSays(setup, 'CALL secret_get {"name":"test-secret"}');
    await leadSays(setup, handoff("household", 'CALL secret_get {"name":"test-secret"}'));
    await leadSays(setup, handoff("research", 'CALL secret_get {"name":"spare"}'));
    const secretsRows = async () =>
      (await harness.activity({ limit: 200 })).records.filter(
        (record) => record.layer === "secrets",
      );
    await until(async () => (await secretsRows()).length === 3);

    // AC-40: the health specialist's brokered call returns the answer, never the token.
    await leadSays(
      setup,
      handoff(
        "health",
        'CALL broker_call {"secret":"health-test","method":"GET","path":"/v1/sleep"}',
      ),
    );
    const brokered = () =>
      setup.gateway.requests.find(
        (request) =>
          request.role === "health" &&
          request.last?.role === "toolResult" &&
          request.lastText.includes("slept 7h 10m"),
      );
    await until(() => brokered() !== undefined);
    expect(targetSeen).toEqual([{ path: "/v1/sleep", header: BROKER_TOKEN }]);
    expect(brokered()?.lastText).toContain("The service answered 200.");

    // AC-42: a call the decision model and the reviewer look at, and a held call, both carrying
    // the value research read.
    stub.decision = riskyAt(0.9);
    await leadSays(
      setup,
      handoff("research", 'CALL household_change {"op":"add","text":"code $SECRET"}'),
    );
    await until(() =>
      setup.gateway.requests.some(
        (request) => isReviewerRequest(request) && request.lastText.includes("household_change"),
      ),
    );
    stub.decision = routineAt(0.05);
    const rule = await secbot(
      setup,
      {},
      "rules",
      "add",
      "research",
      "household_change",
      "ask-first",
      "--exact",
      "op=edit",
    );
    expect(rule.code).toBe(0);
    await leadSays(
      setup,
      handoff("research", 'CALL household_change {"op":"edit","itemId":"i1","text":"$SECRET"}'),
    );
    await until(async () => (await harness.heldCalls()).length === 1);
    const held = await harness.heldCalls();
    const [first] = held;
    await harness.answer(first?.number ?? 0, "deny", { device: "laptop" });

    // AC-38: each refusal is a `secrets` row with its reason.
    const activity = await secbot(setup, {}, "activity");
    await evidence("activity.txt", "activity", activity);
    expect(activity.code).toBe(0);
    const lines = activity.out.split("\n");
    for (const [agent, tool, reason] of [
      ["lead", "secret test-secret", "test-secret is not granted to lead"],
      ["household", "secret test-secret", "test-secret is not granted to household"],
      ["research", "secret spare", "spare is not granted to research"],
    ] as const) {
      const at = lines.findIndex(
        (line) => line.slice(5, 67) === rowBody(agent, tool, "refused", "secrets"),
      );
      expect(at, `${agent} ${tool}`).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe(`         ${reason}`);
    }
    expect(activity.out.split("\n").every((line) => line.length <= 80)).toBe(true);

    // AC-42: the value and the token are nowhere they must not be.
    const records = JSON.stringify(await harness.activity({ limit: 200 }));
    const prompts = JSON.stringify(held);
    const decisions = JSON.stringify(stub.seen);
    const reviews = JSON.stringify(setup.gateway.requests.filter(isReviewerRequest));
    const logs = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(decisions).toContain("household_change");
    expect(reviews).toContain("household_change");
    expect(prompts).toContain("[redacted]");
    for (const [where, text] of Object.entries({ records, prompts, decisions, reviews, logs })) {
      for (const secret of [VALUE, BROKER_TOKEN, SPARE_VALUE]) {
        expect(text.includes(secret), `${secret} in ${where}`).toBe(false);
      }
    }
    for (const result of [added, broker, allowed, granted, listed, activity]) {
      expect(`${result.out}${result.err}`).not.toContain(VALUE);
    }
    // No agent ever saw the broker token or the ungranted value.
    const seenByAgents = JSON.stringify(setup.gateway.requests);
    expect(seenByAgents).not.toContain(BROKER_TOKEN);
    expect(seenByAgents).not.toContain(SPARE_VALUE);

    // AC-45: one `secret.refused` line per refusal, with no value: five refused grants (one for the evidence capture), three reads.
    const refusedLines = loggedEvents([...log.mock.calls, ...warn.mock.calls]).filter(
      (event) => event.event === "secret.refused",
    );
    expect(refusedLines).toHaveLength(8);
    expect(refusedLines.map((event) => event.reason)).toEqual(
      expect.arrayContaining([
        "test-secret is not granted to lead",
        "no agent named builder",
        "test-secret is not in the owner's allowlist for household",
      ]),
    );
  });
});
