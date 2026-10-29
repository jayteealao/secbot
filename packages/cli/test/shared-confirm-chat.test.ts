// A shared job in `secbot chat` against the fake cell: the other person's lead gives the offer in
// its own words, the chat adds the job's line once (also when the frame comes again), and only an
// exact `/join <#>` or `/decline <#>` answers it, through the cell's routes, never the lead. With
// SECBOT_EVIDENCE_DIR set, the run's stdout, stderr, and exit code are written there.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  declinedLine,
  joinedLine,
  SHARED_NOT_SENT,
  sharedLine,
  sharedOf,
} from "../src/commands/shared-confirm.ts";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-shared-confirm-"));
});
afterEach(async () => {
  await cell?.close();
  cell = undefined;
  await rm(dir, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const OFFER =
  "Sam asked me to plan the May trip for both of you. It runs as a shared job; your half is about $0.40.";

// biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control codes.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

describe("the shared-job lines", () => {
  it("match the approved text, both confirm variants, joined, and declined", () => {
    expect(sharedLine(15, "sam", "half")).toBe(
      "[ job 15 shared ] /join 15 to share the cost, /decline 15 to leave it to sam",
    );
    expect(sharedLine(15, "sam", "all")).toBe(
      "[ job 15 shared ] your limit is reached, so sam pays all; /join 15 to see it on\n  your board, /decline 15 to leave it",
    );
    expect(joinedLine(15, "plan the May trip", "half", "sam")).toBe(
      "[ joined ] #15 plan the May trip; you pay half",
    );
    expect(joinedLine(15, "plan the May trip", "you", "sam")).toBe(
      "[ joined ] #15 plan the May trip; you pay all",
    );
    expect(joinedLine(15, "plan the May trip", "them", "sam")).toBe(
      "[ joined ] #15 plan the May trip; sam pays all",
    );
    expect(declinedLine(15, "plan the May trip", "sam")).toBe(
      "[ declined ] #15 plan the May trip; sam's lead was told",
    );
    for (const line of [sharedLine(15, "sam", "all"), sharedLine(15, "sam", "half")]) {
      for (const each of line.split("\n")) {
        expect(each.length).toBeLessThanOrEqual(80);
        expect(each).not.toMatch(CONTROL);
      }
    }
  });

  it("answers only an exact /join <#> or /decline <#>", () => {
    expect(sharedOf("/join 15")).toEqual({ kind: "join", job: 15 });
    expect(sharedOf("/decline 15")).toEqual({ kind: "decline", job: 15 });
    expect(sharedOf("/join fifteen")).toEqual({ kind: "malformed" });
    expect(sharedOf("/JOIN 15 please")).toEqual({ kind: "malformed" });
    expect(sharedOf("/declined 15")).toEqual({ kind: "other" });
    expect(sharedOf("join 15")).toEqual({ kind: "other" });
    expect(SHARED_NOT_SENT).toBe("not sent: answer with /join <#> or /decline <#>");
  });
});

describe("a shared job in secbot chat", () => {
  async function chatWith(
    frames: Record<string, unknown>[],
    script: (out: () => string) => AsyncGenerator<string>,
    setup: (fake: FakeCell) => void,
  ) {
    const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
    const quiet: Io = { stdout: () => {}, stderr: () => {}, lines: async function* () {} };
    expect(await run(["device", "new", "laptop"], { environment, io: quiet })).toBe(0);
    const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
    const fake = await startFakeCell(device.key);
    cell = fake;
    environment.env.SECBOT_CELL_URL = fake.url;
    fake.connectFrames = frames;
    setup(fake);
    let out = "";
    let err = "";
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      lines: () => script(() => out),
    };
    const code = await run(["chat"], { environment, io });
    return { code, out, err, fake };
  }

  const evidence = async (name: string, out: string, err: string, code: number) => {
    const where = process.env.SECBOT_EVIDENCE_DIR;
    if (where === undefined || where === "") return;
    await mkdir(where, { recursive: true });
    await writeFile(join(where, `${name}.stdout.txt`), out);
    await writeFile(join(where, `${name}.stderr.txt`), err);
    await writeFile(join(where, `${name}.exit-code`), `${code}\n`);
  };

  it("prints the lead's words, the job's line once, and joins with /join", async () => {
    const offer = {
      type: "shared",
      job: 15,
      title: "plan the May trip",
      from: "sam",
      payer: "half",
    };
    const { code, out, err, fake } = await chatWith(
      [{ type: "missed", entryId: 40, from: null, text: OFFER, remaining: 0 }, offer, offer],
      async function* (output) {
        await waitFor(() => output().includes("[ job 15 shared ]"));
        yield "/join fifteen";
        yield "/join 15";
        await waitFor(() => output().includes("[ joined ]"));
      },
      (fake) => {
        fake.sharedAnswers["join:15"] = [
          200,
          { job: 15, title: "plan the May trip", from: "sam", payer: "half" },
        ];
      },
    );
    await evidence("shared-confirm-join", out, err, code);
    expect(code).toBe(0);
    expect(err).toBe(`${SHARED_NOT_SENT}\n`);
    expect(out).toBe(
      [
        "connected to owner lead",
        "lead: Sam asked me to plan the May trip for both of you. It runs as a shared",
        "  job; your half is about $0.40.",
        "",
        "[ job 15 shared ] /join 15 to share the cost, /decline 15 to leave it to sam",
        "[ joined ] #15 plan the May trip; you pay half",
        "",
      ].join("\n"),
    );
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(CONTROL);
    }
    expect(fake.inputs).toEqual([]);
    expect(fake.calls.filter((each) => each.path.endsWith("/jobs/15/join"))).toHaveLength(1);
  });

  it("prints the limit variant, declines with /decline, and shows a refusal", async () => {
    const { code, out, err } = await chatWith(
      [{ type: "shared", job: 16, title: "paint the hall", from: "sam", payer: "all" }],
      async function* (output) {
        await waitFor(() => output().includes("[ job 16 shared ]"));
        yield "/decline 16";
        await waitFor(() => output().includes("[ declined ]"));
        // The chat reads the next line only after this one's answer: the refusal is printed then.
        yield "/decline 17";
      },
      (fake) => {
        fake.sharedAnswers["decline:16"] = [
          200,
          { job: 16, title: "paint the hall", from: "sam", payer: "them" },
        ];
      },
    );
    await evidence("shared-confirm-decline", out, err, code);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "connected to owner lead",
        "",
        "[ job 16 shared ] your limit is reached, so sam pays all; /join 16 to see it on",
        "  your board, /decline 16 to leave it",
        "[ declined ] #16 paint the hall; sam's lead was told",
        "",
      ].join("\n"),
    );
    expect(err).toBe("secbot: no shared job #17 waits for you\n");
  });
});
