// The job commands against the stand-in cell: urgent, deadline, clear, and move print the job's
// new place byte for byte with the approved lines; a missing job prints `no job #<n>` on stderr
// with exit code 1; a malformed number or date prints the usage line with exit code 2. A restart
// prints its line, a paused job's line on stdout, and a missing or unstopped job on stderr.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CellClient } from "../src/client.ts";
import { jobsReorder, jobsRestart, ordinal } from "../src/commands/jobs.ts";
import type { Io } from "../src/io.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

const KEY = "device-key-0123456789abcdef0123456789abcdef";
let cell: FakeCell;
let client: CellClient;

beforeEach(async () => {
  cell = await startFakeCell(KEY);
  client = new CellClient(cell.url, { name: "laptop", person: "owner", key: KEY });
});
afterEach(async () => {
  await cell.close();
});

function capture(): Io & { out: string; err: string } {
  const io = {
    out: "",
    err: "",
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
    lines: async function* () {},
  };
  return io;
}

const TITLE = "council tax letter summary";
const placed = (place: number, extra: Record<string, unknown> = {}) => ({
  job: 16,
  title: TITLE,
  priority: "urgent",
  deadline: null,
  place,
  of: 4,
  ...extra,
});

describe("secbot jobs urgent, deadline, and move", () => {
  it("prints each approved reorder line", async () => {
    const lines: string[] = [];
    const runs: [Parameters<typeof jobsReorder>[2], (string | undefined)[], string?][] = [
      ["urgent", ["16"]],
      ["deadline", ["16", "2026-10-12"]],
      ["deadline", ["16", "clear"]],
      ["move", ["16"], "14"],
    ];
    const answers = [
      placed(1),
      placed(2, { priority: "deadline", deadline: "2026-10-12" }),
      placed(3, { priority: "routine" }),
      placed(1, { before: 14 }),
    ];
    for (const [index, [change, args, before]] of runs.entries()) {
      cell.priorityAnswers[16] = [200, answers[index]];
      const io = capture();
      expect(await jobsReorder(client, io, change, args, before)).toBe(0);
      expect(io.err).toBe("");
      lines.push(io.out);
    }
    expect(lines.join("")).toBe(
      [
        "[ urgent ] #16 council tax letter summary -> now 1st of 4 live jobs",
        "[ due 12 Oct ] #16 council tax letter summary -> now 2nd of 4 live jobs",
        "[ no deadline ] #16 council tax letter summary -> now 3rd of 4 live jobs",
        "[ moved ] #16 council tax letter summary -> now before #14, 1st of 4 live jobs",
        "",
      ].join("\n"),
    );
    const bodies = cell.calls
      .filter((call) => call.path.endsWith("/priority"))
      .map((call) => call.body);
    expect(bodies).toEqual([
      { urgent: true },
      { deadline: "2026-10-12" },
      { deadline: null },
      { before: 14 },
    ]);
  });

  it("prints no job #<n> on stderr with exit code 1, and an ended job's line", async () => {
    const io = capture();
    expect(await jobsReorder(client, io, "urgent", ["22"])).toBe(1);
    expect(io.out).toBe("");
    expect(io.err).toBe("no job #22\n");
    cell.priorityAnswers[9] = [409, { error: "job 9 has ended", reason: "ended", job: 9 }];
    const ended = capture();
    expect(await jobsReorder(client, ended, "urgent", ["9"])).toBe(1);
    expect(ended.err).toBe("job 9 has ended\n");
  });

  it("prints the usage line with exit code 2 for a malformed number or date, and sends nothing", async () => {
    const cases: [Parameters<typeof jobsReorder>[2], (string | undefined)[], string?][] = [
      ["urgent", []],
      ["urgent", ["0"]],
      ["urgent", ["x"]],
      ["deadline", ["16"]],
      ["deadline", ["16", "2026-02-30"]],
      ["deadline", ["16", "12/10/2026"]],
      ["move", ["16"]],
      ["move", ["16"], "first"],
    ];
    for (const [change, args, before] of cases) {
      const io = capture();
      expect(await jobsReorder(client, io, change, args, before)).toBe(2);
      expect(io.err).toMatch(/^usage: secbot jobs /);
    }
    expect(cell.calls).toEqual([]);
  });

  it("writes ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ]);
  });
});

describe("secbot jobs restart", () => {
  it("prints the approved restart lines and their exit codes", async () => {
    cell.restartAnswers[14] = [200, { job: 14, title: "flights to Lisbon in May" }];
    cell.restartAnswers[12] = [
      409,
      {
        error: "job 12 is paused, not stopped",
        reason: "paused",
        job: 12,
        title: "compare broadband deals",
      },
    ];
    cell.restartAnswers[9] = [409, { error: "no stopped job #9", reason: "not-stopped" }];
    cell.restartAnswers[7] = [409, { error: "a stop is running; try again", reason: "locked" }];
    const ran = async (n: string) => {
      const io = capture();
      const code = await jobsRestart(client, io, [n]);
      return { code, out: io.out, err: io.err };
    };
    expect(await ran("14")).toEqual({
      code: 0,
      out: "[ restarted ] #14 flights to Lisbon in May, from its kept brief and transcript\n",
      err: "",
    });
    expect(await ran("12")).toEqual({
      code: 1,
      out: "[ restarted ] #12 compare broadband deals is paused, not stopped; ask the lead\n",
      err: "",
    });
    expect(await ran("22")).toEqual({ code: 1, out: "", err: "no stopped job #22\n" });
    expect(await ran("9")).toEqual({ code: 1, out: "", err: "no stopped job #9\n" });
    expect(await ran("7")).toEqual({
      code: 1,
      out: "",
      err: "secbot: a stop is running; try again\n",
    });
    const usage = capture();
    expect(await jobsRestart(client, usage, ["x"])).toBe(2);
    expect(usage.err).toBe("usage: secbot jobs restart <#>\n");
  });
});
