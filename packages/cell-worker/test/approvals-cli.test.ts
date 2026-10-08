// The charter scenario, steps 1-6, as one scripted session: the real `secbot` command line against
// the worker's routes and a real person cell on the stand-in (no network). The stand-in worker has
// no WebSocket runtime, so the chat half reads the cell's own session frames and prints them with
// the command line's renderer, and answers through the command line's real answer path and route.
// With SECBOT_EVIDENCE_DIR set, the transcript is written there as charter-1-6.txt.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, HeldCallView } from "@secbot/cell-harness";
import { until } from "@secbot/cell-harness/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type StubOpenRouter,
  startStubOpenRouter,
} from "../../cell-harness/test/stub-openrouter.ts";
import { CellClient } from "../../cli/src/client.ts";
import { answerHeld, type HeldCall, heldBlock } from "../../cli/src/commands/held.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  workerFetch,
} from "./guard-setup.ts";

let dir: string;
let s: GuardSetup | undefined;
let stub: StubOpenRouter | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-charter-"));
  await writeFile(
    join(dir, "device.json"),
    JSON.stringify({ name: "laptop", person: "owner", key: KEY }),
  );
});
afterEach(async () => {
  if (s !== undefined) await closeAll(s);
  s = undefined;
  await stub?.close();
  stub = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function capture(): Io & { readonly out: () => string; readonly err: () => string } {
  let out = "";
  let err = "";
  return {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: async function* () {},
    out: () => out,
    err: () => err,
  };
}

describe("the charter scenario, steps 1-6, against the cell routes", () => {
  it("holds, answers, remembers, and refuses as the scenario says", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stub = await startStubOpenRouter();
    s = await guardSetup();
    const setup = s;
    const transcript: string[] = [];
    const environment = {
      env: {
        SECBOT_CONFIG_DIR: dir,
        SECBOT_CELL_URL: `http://${HOST}`,
        SECBOT_OPERATOR_KEY: OPERATOR_KEY,
      },
      home: dir,
    };
    const secbot = async (...argv: string[]) => {
      const io = capture();
      const code = await run(argv, { environment, io, fetch: workerFetch(setup) });
      transcript.push(`$ secbot ${argv.join(" ")}`, io.out() + io.err());
      return { code, out: io.out(), err: io.err() };
    };
    const client = new CellClient(
      `http://${HOST}`,
      { name: "laptop", person: "owner", key: KEY },
      workerFetch(setup),
    );
    const answer = async (line: string, choice: "allow" | "always" | "deny", n: number) => {
      const io = capture();
      await answerHeld(client, io, choice, n);
      transcript.push(`> ${line}`, io.out() + io.err());
      return io.out();
    };

    // 1. The member adds an ask-first rule for the lead's hand-off; the list shows it.
    expect(await secbot("rules", "add", "lead", "handoff", "ask-first")).toMatchObject({
      code: 0,
      out: "added: lead handoff (any) -> ask first\n",
    });
    const listed = await secbot("rules", "list");
    expect(listed.out).toContain(
      "YOUR RULES\n------------------------------------------------------------------------------\nAGENT   TOOL               MATCH                          VERDICT\nall     handoff            any                            permit\n",
    );
    expect(listed.out).toContain(
      "lead    handoff            any                            ask first\n",
    );

    // The session: the cell's own frames, printed by the command line's renderer.
    const harness = setup.harness("owner");
    const frames: Frame[] = [];
    const session = await harness.session((frame) => frames.push(frame));
    const heldFrames = () =>
      frames.filter((frame): frame is Extract<Frame, { type: "held" }> => frame.type === "held");
    const cell = setup.cells.get("owner");
    /** `said` is what the transcript shows: the scripted model line itself carries a test key. */
    const chat = async (line: string, id: string, said: string) => {
      transcript.push(`> ${said}`);
      await cell?.submitInput("owner", line, id);
    };
    const show = (call: HeldCallView, count: number) => {
      const block = heldBlock(call as HeldCall, count);
      transcript.push(`\n${block.join("\n")}`);
      return block;
    };
    const briefs = (role: string) =>
      setup.gateway.requests.filter((r) => r.role === role && r.lastText.startsWith("Ask ")).length;

    // 2. The lead hands off; the chat shows the held call with "your rule" and three answers.
    const secret = "sk-test-charter0123456789abcdef"; // gitleaks:allow (fake test token)
    const handoff = (specialist: string) =>
      `CALL handoff ${JSON.stringify({ specialist, brief: `Ask ${specialist}.`, api_key: secret })}`;
    await chat(handoff("research"), "charter-2", "(the lead hands off to research)");
    await until(() => heldFrames().length === 1);
    const [first] = heldFrames();
    const block = show(first?.call as HeldCallView, first?.count ?? 0);
    expect(block[0]).toMatch(
      /^\[ HELD #1 \] the lead wants to run a tool +lapses in 2[34] h \d+ m$/,
    );
    expect(block).toContain("  agent      lead");
    expect(block).toContain("  tool       handoff");
    expect(block).toContain("             api_key = [redacted]");
    expect(block).toContain("  why held   your rule: lead handoff (any) -> ask first");
    expect(block).toContain("  answer     /allow 1     allow once");
    expect(block).toContain("             /always 1    allow always; adds: lead handoff");
    expect(block).toContain("             /deny 1      deny");

    // 3. /always 1: the hand-off runs; the list shows the added rule; activity shows "person".
    expect(await answer("/always 1", "always", 1)).toBe(
      "[ allowed always ] #1 handoff -> research; added rule: lead handoff\n  (specialist = research) -> permit\n",
    );
    await until(() => briefs("research") === 1);
    const afterAlways = await secbot("rules", "list");
    expect(afterAlways.out).toMatch(
      /lead {4}handoff {12}specialist = research {10}permit\n {10}added by allow always, \d{1,2} \w{3} \d\d:\d\d\n/,
    );
    const activity3 = await secbot("activity");
    expect(activity3.out).toMatch(/lead {7}handoff -> research {6}allowed {7}person/);
    expect(activity3.out).toContain("         allowed always by owner\n");
    expect(activity3.out).toMatch(/lead {7}handoff -> research {6}held {10}rule/);

    // 4. The same hand-off again: no prompt; activity shows the layer "rule".
    await chat(handoff("research"), "charter-4", "(the lead hands off to research again)");
    await until(() => briefs("research") === 2);
    expect(heldFrames()).toHaveLength(1);
    const activity4 = await secbot("activity");
    const rows4 = activity4.out.split("\n");
    expect(rows4[3]).toMatch(/lead {7}handoff -> research {6}allowed {7}rule/);
    expect(rows4[4]).toBe("         your rule: lead handoff (specialist = research) -> permit");

    // 5. The owner's ask-first rule on hand-offs to the developer: only /allow and /deny.
    expect(
      await secbot(
        "rules",
        "add",
        "all",
        "handoff",
        "ask-first",
        "--exact",
        "specialist=developer",
        "--owner",
        "--person",
        "owner",
      ),
    ).toMatchObject({ code: 0, out: "added: all handoff (specialist = developer) -> ask first\n" });
    await chat(handoff("developer"), "charter-5", "(the lead hands off to developer)");
    await until(() => heldFrames().length === 2);
    const second = heldFrames()[1];
    const ownerBlock = show(second?.call as HeldCallView, second?.count ?? 0);
    expect(ownerBlock).toContain(
      "  why held   owner rule: all handoff (specialist = developer) -> ask first",
    );
    expect(ownerBlock).toContain(
      "             (allow always is not offered: an owner rule asks first here)",
    );
    expect(ownerBlock.join("\n")).not.toContain("/always 2");
    expect(await answer("/allow 2", "allow", 2)).toBe("[ allowed once ] #2 handoff -> developer\n");
    await until(() => briefs("developer") === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(briefs("developer")).toBe(1);

    // 6. A prohibit rule: the agent gets a refusal with the rule; activity shows "rule"; the
    // decision-model stub records zero requests.
    expect(
      (await secbot("rules", "add", "lead", "search_history", "prohibit", "--exact", "query=bank"))
        .code,
    ).toBe(0);
    await chat(
      `CALL search_history ${JSON.stringify({ query: "bank" })}`,
      "charter-6",
      "(the lead searches its history for bank)",
    );
    await until(async () => (await harness.activity()).records[0]?.tool === "search_history");
    const activity6 = await secbot("activity");
    const rows6 = activity6.out.split("\n");
    expect(rows6[3]).toMatch(/lead {7}search_history {11}refused {7}rule/);
    expect(rows6[4]).toBe("         your rule: lead search_history (query = bank) -> prohibit");
    expect(stub.seen).toEqual([]);

    await session.stop();
    const text = transcript.join("\n");
    expect(text).not.toContain(secret);
    // Every printed line fits 80 columns (the echoed commands are the test's, not output).
    const printed = text.split("\n").filter((line) => !/^(\$ secbot|> )/.test(line));
    expect(printed.filter((line) => line.length > 80)).toEqual([]);
    const evidence = process.env.SECBOT_EVIDENCE_DIR;
    if (evidence !== undefined && evidence !== "") {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, "charter-1-6.txt"), `${text}\n`);
    }
  });
});
