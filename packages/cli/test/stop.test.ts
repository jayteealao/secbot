// `secbot stop` and `secbot stop --all` against the stand-in cell, byte for byte with the approved
// lines: three jobs and the lead's turn, one job, nothing running, every cell of the household,
// and a fleet that did not answer (stderr and exit code 1). There is no prompt.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CellClient, OperatorClient } from "../src/client.ts";
import { stopAll, stopOwn } from "../src/commands/stop.ts";
import type { Io } from "../src/io.ts";
import { type FakeCell, startFakeCell } from "./fake-cell.ts";

const KEY = "device-key-0123456789abcdef0123456789abcdef";
let cell: FakeCell;

beforeEach(async () => {
  cell = await startFakeCell(KEY);
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

const own = async () => {
  const io = capture();
  const code = await stopOwn(
    new CellClient(cell.url, { name: "laptop", person: "owner", key: KEY }),
    io,
  );
  return { code, out: io.out, err: io.err };
};
const all = async () => {
  const io = capture();
  const code = await stopAll(new OperatorClient(cell.url, cell.operatorKey), io);
  return { code, out: io.out, err: io.err };
};

describe("secbot stop", () => {
  it("stops the person's jobs and the lead's turn", async () => {
    cell.stopAnswer = { jobs: 3, turn: true };
    expect(await own()).toEqual({
      code: 0,
      out: [
        "[ stopped ] 3 jobs and the lead's current turn. Their state is kept.",
        "  Routines and reminders keep their schedule.",
        "  Restart one: secbot jobs restart <#>",
        "",
      ].join("\n"),
      err: "",
    });
    expect(cell.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/cells/owner/stop",
    ]);
  });

  it("words one job, and nothing running", async () => {
    cell.stopAnswer = { jobs: 1, turn: false };
    expect((await own()).out).toBe(
      [
        "[ stopped ] 1 job. Their state is kept.",
        "  Routines and reminders keep their schedule.",
        "  Restart one: secbot jobs restart <#>",
        "",
      ].join("\n"),
    );
    cell.stopAnswer = { jobs: 0, turn: false };
    expect((await own()).out).toBe(
      "[ stopped ] nothing was running. Routines and reminders keep their schedule.\n",
    );
  });
});

describe("secbot stop --all", () => {
  it("prints the household's totals and each cell", async () => {
    cell.opsStop = {
      cells: [
        { cell: "alex", jobs: 3, turn: true, shared: false },
        { cell: "sam", jobs: 1, turn: true, shared: false },
        { cell: "household", jobs: 1, turn: false, shared: true },
      ],
      missing: [],
    };
    expect(await all()).toEqual({
      code: 0,
      out: [
        "[ stopped ] household: 5 jobs and 2 lead turns. Their state is kept.",
        "  alex      3 jobs, lead turn",
        "  sam       1 job, lead turn",
        "  household 1 shared job",
        "",
      ].join("\n"),
      err: "",
    });
  });

  it("names the cells that did not answer on stderr, with exit code 1", async () => {
    cell.opsStop = {
      cells: [
        { cell: "alex", jobs: 3, turn: true, shared: false },
        { cell: "sam", jobs: 1, turn: true, shared: false },
      ],
      missing: ["household"],
    };
    const ran = await all();
    expect(ran.code).toBe(1);
    expect(ran.out).toBe(
      [
        "[ stopped ] household: 4 jobs and 2 lead turns. Their state is kept.",
        "  alex      3 jobs, lead turn",
        "  sam       1 job, lead turn",
        "",
      ].join("\n"),
    );
    expect(ran.err).toBe(
      [
        "secbot: stop incomplete: household did not answer; alex and sam stopped.",
        "  run secbot stop --all again",
        "",
      ].join("\n"),
    );
  });
});
