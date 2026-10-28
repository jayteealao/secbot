// AC-22 in `secbot chat` against the fake cell: a job's question the lead put to the person while
// they were away arrives as the lead's own words, a blank line, and the job's line; the person
// answers with `/answer`, which goes to the cell's answer route, and the job continues. With
// SECBOT_EVIDENCE_DIR set, the run's stdout, stderr, and exit code are written there.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/io.ts";
import { run } from "../src/main.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

let dir: string;
let cell: FakeCell | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secbot-job-question-"));
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

const ASKED =
  "The passport job needs one fact from you: which address goes on the form, home or the office?";

/** The spec's chat block, after the connected line. */
const SPEC = [
  "lead: The passport job needs one fact from you: which address goes on the form,",
  "  home or the office?",
  "",
  "[ job 11 asks ] answer with /answer 11 <text>",
  "[ answered ] #11 renew passport form continues",
  "",
].join("\n");

describe("a job's question in secbot chat (AC-22)", () => {
  it("prints the lead's words, then the job's line, and answers it with /answer", async () => {
    const environment = { env: { SECBOT_CONFIG_DIR: dir } as Record<string, string>, home: dir };
    const quiet: Io = { stdout: () => {}, stderr: () => {}, lines: async function* () {} };
    expect(await run(["device", "new", "laptop"], { environment, io: quiet })).toBe(0);
    const device = JSON.parse(await readFile(join(dir, "device.json"), "utf8")) as { key: string };
    cell = await startFakeCell(device.key);
    environment.env.SECBOT_CELL_URL = cell.url;
    const fake = cell;
    // The person was away when the lead asked: the session opens with the missed message, then
    // the open question.
    fake.connectFrames = [
      { type: "missed", entryId: 40, from: null, text: ASKED, remaining: 0 },
      { type: "question", job: 11, title: "renew passport form" },
    ];
    fake.jobAnswers[11] = [200, { job: 11, title: "renew passport form" }];

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
        await waitFor(() => out.includes("[ job 11 asks ]"));
        yield "/answer 11 home address";
        await waitFor(() => out.includes("[ answered ]"));
      },
    };
    const code = await run(["chat"], { environment, io });
    const where = process.env.SECBOT_EVIDENCE_DIR;
    if (where !== undefined && where !== "") {
      await mkdir(where, { recursive: true });
      await writeFile(join(where, "ac-22-job-question.stdout.txt"), out);
      await writeFile(join(where, "ac-22-job-question.stderr.txt"), err);
      await writeFile(join(where, "ac-22-job-question.exit-code"), `${code}\n`);
    }
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(`connected to owner lead\n${SPEC}`);
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(80);
    // Nothing went to the lead: the answer took the cell's answer route.
    expect(fake.inputs).toEqual([]);
    expect(fake.calls.filter((each) => each.path.endsWith("/jobs/11/answer"))).toEqual([
      expect.objectContaining({ method: "POST", body: { text: "home address" } }),
    ]);
  });
});
