// node:test tests for the check:cells phrases (scripts/vps.mjs reportCells).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CELLS, reportCells } from "./vps.mjs";

const up = (version) => ({ status: "up", version, roles: ["lead"] });

test("every person cell up passes and prints one line per cell", () => {
  const report = reportCells({ cells: { owner: up("v1.0.0"), second: up("v1.0.0") } });
  assert.equal(DEFAULT_CELLS, "owner,second");
  assert.deepEqual(report, { ok: true, lines: ["cell owner up v1.0.0", "cell second up v1.0.0"] });
});

test("a down cell, a missing cell, or another version fails", () => {
  const report = reportCells(
    { cells: { owner: up("v1.0.0"), second: { status: "down", reason: "status 500" } } },
    { cells: "owner,second,household", version: "v1.0.1" },
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.lines, [
    "cell owner up v1.0.0 (expected v1.0.1)",
    "cell second down: status 500",
    "cell household down: no answer",
  ]);
});

test("a health answer without cells fails every cell", () => {
  assert.equal(reportCells({ version: "v1.0.0" }).ok, false);
});
