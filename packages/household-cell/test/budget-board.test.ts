// The household budget board: each cell's newest month report, the developer spend of every cell
// summed, one cell per developer alert line, and the owner's settings checked before they land.
import { describe, expect, it } from "vitest";
import { CelldSqliteDatabase } from "../../cell-storage/src/index.ts";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { BUDGET_CLAIM_STALE_MS, BudgetBoardStore } from "../src/budget-board.ts";
import { RefusedHouseholdChange } from "../src/change-log.ts";

const open = () => {
  const clock = { now: 1_000 };
  const board = new BudgetBoardStore(
    new CelldSqliteDatabase(new FakeCelldStorage()),
    () => clock.now,
  );
  return { board, clock };
};

const report = (opId: string, cell: string, fields: Record<string, unknown> = {}) => ({
  opId,
  cell,
  month: "2026-10",
  timeZone: "Europe/London",
  at: 1_000,
  spentUsd: 4,
  limitUsd: 25,
  mode: "shadow",
  modeSince: null,
  byLayer: { agent: 3, decision: 0.5, reviewer: 0.5 },
  byRole: { developer: 2 },
  developerUsd: 2,
  developerLimitUsd: 50,
  developerLines: [],
  ...fields,
});

describe("household budget board", () => {
  it("keeps each cell's newest report and sums the developer spend", async () => {
    const { board } = open();
    await board.reportSpend(report("a-1", "owner", { at: 2_000, developerUsd: 10 }));
    await board.reportSpend(report("a-0", "owner", { at: 1_500, developerUsd: 99 }));
    const result = await board.reportSpend(report("b-1", "sam", { developerUsd: 5 }));
    expect(result.othersDeveloperUsd).toBe(10);
    expect(result.board.developerUsd).toBe(15);
    expect(result.board.reports.map((each) => [each.cell, each.developerUsd])).toEqual([
      ["owner", 10],
      ["sam", 5],
    ]);
  });

  it("shows only the newest month", async () => {
    const { board } = open();
    await board.reportSpend(report("a-1", "owner", { month: "2026-09", developerUsd: 40 }));
    await board.reportSpend(report("a-2", "sam", { month: "2026-10", developerUsd: 1 }));
    const { reports, developerUsd } = await board.board();
    expect(reports.map((each) => each.cell)).toEqual(["sam"]);
    expect(developerUsd).toBe(1);
  });

  it("applies a report once per operation id", async () => {
    const { board } = open();
    const first = await board.reportSpend(report("op-1", "owner", { developerLines: [80] }));
    const again = await board.reportSpend(report("op-1", "owner", { developerLines: [80] }));
    expect(first.alerts).toEqual([{ line: 80, status: "yours" }]);
    expect(again.alerts).toEqual(first.alerts);
  });

  it("lets one cell send each developer alert line", async () => {
    const { board, clock } = open();
    const owner = await board.reportSpend(report("o-1", "owner", { developerLines: [80] }));
    const sam = await board.reportSpend(report("s-1", "sam", { developerLines: [80] }));
    expect(owner.alerts).toEqual([{ line: 80, status: "yours" }]);
    expect(sam.alerts).toEqual([{ line: 80, status: "taken" }]);
    await board.alertSent({
      month: "2026-10",
      budget: "developer",
      limitUsd: 50,
      line: 80,
      cell: "owner",
      sent: true,
    });
    clock.now += BUDGET_CLAIM_STALE_MS * 2;
    const later = await board.reportSpend(report("s-2", "sam", { developerLines: [80] }));
    expect(later.alerts).toEqual([{ line: 80, status: "sent" }]);
  });

  it("frees a claim that was not sent, or that went stale", async () => {
    const { board, clock } = open();
    await board.reportSpend(report("o-1", "owner", { developerLines: [100] }));
    await board.alertSent({
      month: "2026-10",
      budget: "developer",
      limitUsd: 50,
      line: 100,
      cell: "owner",
      sent: false,
    });
    const sam = await board.reportSpend(report("s-1", "sam", { developerLines: [100] }));
    expect(sam.alerts).toEqual([{ line: 100, status: "yours" }]);
    clock.now += BUDGET_CLAIM_STALE_MS + 1;
    const owner = await board.reportSpend(report("o-2", "owner", { developerLines: [100] }));
    expect(owner.alerts).toEqual([{ line: 100, status: "yours" }]);
  });

  it("claims a line again after the developer budget changes", async () => {
    const { board } = open();
    await board.reportSpend(report("o-1", "owner", { developerLines: [80] }));
    await board.alertSent({
      month: "2026-10",
      budget: "developer",
      limitUsd: 50,
      line: 80,
      cell: "owner",
      sent: true,
    });
    const raised = await board.reportSpend(
      report("o-2", "owner", { developerLimitUsd: 60, developerLines: [80] }),
    );
    expect(raised.alerts).toEqual([{ line: 80, status: "yours" }]);
  });

  it("stores the owner's settings and refuses a bad zone or amount", async () => {
    const { board } = open();
    expect((await board.board()).settings).toEqual({ timeZone: null, developerLimitUsd: null });
    await expect(board.setBudget({ timeZone: "Mars/Olympus" })).rejects.toBeInstanceOf(
      RefusedHouseholdChange,
    );
    await expect(board.setBudget({ developerLimitUsd: 0 })).rejects.toBeInstanceOf(
      RefusedHouseholdChange,
    );
    await expect(board.setBudget({ developerLimitUsd: 1.234 })).rejects.toBeInstanceOf(
      RefusedHouseholdChange,
    );
    await expect(board.setBudget({})).rejects.toBeInstanceOf(RefusedHouseholdChange);
    expect(await board.setBudget({ timeZone: "Europe/London" })).toEqual({
      timeZone: "Europe/London",
      developerLimitUsd: null,
    });
    expect(await board.setBudget({ developerLimitUsd: 60 })).toEqual({
      timeZone: "Europe/London",
      developerLimitUsd: 60,
    });
  });

  it("refuses a report with a bad cell, month, or amount", async () => {
    const { board } = open();
    for (const bad of [
      report("x-1", "Bad Cell"),
      report("x-2", "owner", { month: "2026-13" }),
      report("x-3", "owner", { spentUsd: -1 }),
      report("x-4", "owner", { developerLines: [50] }),
      report("bad id!", "owner"),
    ]) {
      await expect(board.reportSpend(bad)).rejects.toBeInstanceOf(RefusedHouseholdChange);
    }
  });
});
