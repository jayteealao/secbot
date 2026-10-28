// The lead's remote tools run in the background: a call answers with a receipt in its own round,
// while the other cell has not answered yet, and the stored result is readable afterwards.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptDoc, ReceiptsDoc } from "../src/docs.ts";
import type { HouseholdClient } from "../src/household-tools.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { answersOf, toolResultsOf } from "./job-helpers.ts";
import { jobResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

/** A household cell whose reads wait until `release()`. */
function heldHousehold() {
  const stub = createHouseholdStub();
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reads = 0;
  const client: HouseholdClient = {
    ...stub,
    read: async (document) => {
      reads++;
      await gate;
      return stub.read(document);
    },
  };
  return { stub, client, release: () => open(), reads: () => reads };
}

const openRemoteCell = (household: HouseholdClient): Promise<TestCell> =>
  openTestCell({ gateway: createFauxGateway(jobResponder), household });

describe("background receipts", () => {
  it("answers a held household read with a receipt in the round, and stores the result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const household = heldHousehold();
    await household.stub.apply({
      opId: "seed",
      document: "list",
      fromCell: "owner",
      kind: "add",
      text: "milk",
    });
    test = await openRemoteCell(household.client);
    const t = test;
    await (await t.cell.submit("CALL household_read {}", "req-1")).wait(BACKGROUND_CONTEXT);
    // The round ended and the lead answered while the household cell has not answered.
    expect(household.reads()).toBe(1);
    expect(await toolResultsOf(t.cell.root)).toEqual([
      "receipt r1: household_read runs in the background; read it with read_result.",
    ]);
    expect(await answersOf(t.cell.root)).toEqual(["OK."]);
    expect(
      (await t.cell.harness.snapshot(ReceiptDoc, "r1", BACKGROUND_CONTEXT))?.receipt,
    ).toMatchObject({ tool: "household_read", status: "running" });

    await (await t.cell.submit('CALL read_result {"receipt":"r1"}', "req-2")).wait(
      BACKGROUND_CONTEXT,
    );
    expect((await toolResultsOf(t.cell.root)).at(-1)).toBe("receipt r1: still running.");

    household.release();
    await until(
      async () =>
        (await t.cell.harness.snapshot(ReceiptDoc, "r1", BACKGROUND_CONTEXT))?.receipt?.status ===
        "done",
    );
    await (await t.cell.submit('CALL read_result {"receipt":"r1"}', "req-3")).wait(
      BACKGROUND_CONTEXT,
    );
    expect((await toolResultsOf(t.cell.root)).at(-1)).toContain("- [ ] milk");
    expect((await t.cell.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.open).toEqual([]);
  });

  it("flags a secret's receipt as sensitive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openRemoteCell(createHouseholdStub());
    const t = test;
    await (await t.cell.submit('CALL secret_get {"name":"wifi"}', "req-1")).wait(
      BACKGROUND_CONTEXT,
    );
    await until(
      async () =>
        (await t.cell.harness.snapshot(ReceiptDoc, "r1", BACKGROUND_CONTEXT))?.receipt?.status ===
        "done",
    );
    expect(
      (await t.cell.harness.snapshot(ReceiptDoc, "r1", BACKGROUND_CONTEXT))?.receipt,
    ).toMatchObject({ tool: "secret_get", sensitive: true, isError: true });
  });
});
