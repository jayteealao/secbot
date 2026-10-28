// The lead's remote tools run in the background: a call answers with a receipt in its own round,
// while the other cell has not answered yet, and the stored result is readable afterwards. Every
// tool on the lead's list returns in its own round while every backend is held (AC-9).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptDoc, ReceiptsDoc } from "../src/docs.ts";
import type { HouseholdClient } from "../src/household-tools.ts";
import type { SecretsClient } from "../src/secret-tools.ts";
import { job, leadCalls } from "./escalation-helpers.ts";
import {
  createFauxGateway,
  createHouseholdStub,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  resultReviewer,
  type TestCell,
  until,
} from "./fixtures.ts";
import { answersOf, toolResultsOf } from "./job-helpers.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

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

/** One gate that every held backend waits on until `release()`. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let waiting = 0;
  return {
    wait: async () => {
      waiting++;
      await opened;
      waiting--;
    },
    release: () => open(),
    waiting: () => waiting,
  };
}

/** A secrets cell whose reads and brokered calls wait on `held`. */
function heldSecrets(held: ReturnType<typeof gate>): SecretsClient {
  const refused = async (): Promise<never> => {
    throw new Error("not in this test");
  };
  return {
    get: async () => {
      await held.wait();
      return { value: "wifi-password-0000" };
    },
    broker: async () => {
      await held.wait();
      return { status: 200, body: "pong" };
    },
    list: async () => [],
    grant: refused,
    revoke: refused,
    add: refused,
    allowlist: refused,
    rotate: refused,
    redactionValues: async () => [],
  };
}

/** The scripted arguments of every lead tool, in the order the rounds call them. */
const CASES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["household_read", {}],
  ["household_change", { op: "add", text: "eggs" }],
  ["secret_get", { name: "wifi" }],
  ["broker_call", { secret: "health-test", method: "GET", path: "/v1/ping" }],
  ["start_job", { title: "trains", brief: "Find trains.", template: "research" }],
  ["read_job", { job: 1 }],
  ["job_result", { job: 1 }],
  ["set_job", { job: 1, effort: "high" }],
  ["job_transcript", { job: 1 }],
  ["mark_risky", { job: 1, reason: "it books trains" }],
  ["answer_job", { job: 1, answer: "the morning train" }],
  ["ask_person", { job: 1 }],
  ["restart_job", { job: 9, note: "No job 9: the round still ends with a refusal." }],
  ["read_result", { receipt: "r1" }],
  ["note_bookmark", { sentence: "I was checking the tools." }],
  ["resume_work", {}],
  ["search_history", { query: "eggs" }],
  ["set_reminder", { at: "2030-01-01T09:00:00Z", text: "bins out" }],
];

describe("every lead tool returns in its round (AC-9)", () => {
  it("ends each tool's round while every backend is held, and the background results read afterwards", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const held = gate();
    const stub = createHouseholdStub();
    const household: HouseholdClient = {
      ...stub,
      read: async (document) => {
        await held.wait();
        return stub.read(document);
      },
      apply: async (change) => {
        await held.wait();
        return stub.apply(change);
      },
    };
    // The job's model is held too: no backend answers before every round has ended.
    const models = createHold();
    models.hold("research");
    test = await openTestCell({
      gateway: createFauxGateway(models.wrap(jobResponder)),
      household,
      secrets: heldSecrets(held),
    });
    const t = test;

    // The cases cover the lead's resolved tool list exactly: a tool added later fails here.
    const tools = (await t.cell.root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    expect(CASES.map(([name]) => name).sort()).toEqual([...tools].sort());

    for (const [index, [name, args]] of CASES.entries()) {
      const submission = await t.cell.submit(
        `CALL ${name} ${JSON.stringify(args)}`,
        `ac9-${index}`,
      );
      const ended = await Promise.race([
        submission.wait(BACKGROUND_CONTEXT).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      expect(ended, `${name} returned in its round`).toBe(true);
      const result = (await toolResultsOf(t.cell.root)).at(-1) ?? "";
      expect(result, name).not.toBe("");
    }
    // Nothing was released while the rounds ran: the four remote calls still wait.
    await until(() => held.waiting() === 4);
    expect(models.waiting("research")).toBe(1);

    held.release();
    models.release("research");
    for (const receipt of ["r1", "r2", "r3", "r4"]) {
      await until(
        async () =>
          (await t.cell.harness.snapshot(ReceiptDoc, receipt, BACKGROUND_CONTEXT))?.receipt
            ?.status === "done",
      );
      await (
        await t.cell.submit(`CALL read_result {"receipt":"${receipt}"}`, `ac9-read-${receipt}`)
      ).wait(BACKGROUND_CONTEXT);
      expect((await toolResultsOf(t.cell.root)).at(-1), receipt).not.toMatch(/still running/);
    }
    const answers = (await toolResultsOf(t.cell.root)).slice(-4).join("\n");
    expect(answers).toContain("receipt r2 (household_change)");
    expect(answers).toContain("pong");
  }, 60_000);
});

describe("job_result on a result under review (AC-9)", () => {
  it("returns in its round with the review hold while the reviewer is held", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const models = createHold();
    // The reviewer's requests are held: its instructions name no specialist.
    models.hold("unknown");
    test = await openTestCell({
      gateway: createFauxGateway(
        models.wrap(
          resultReviewer((request) =>
            request.role === "health"
              ? fauxAssistantMessage([fauxText("Sleep eight hours.")])
              : jobResponder(request),
          ),
        ),
      ),
    });
    const t = test;
    await (
      await t.cell.submit(
        startJobLine({ title: "sleep", brief: "sleep advice", template: "health" }),
        "rv-1",
      )
    ).wait(BACKGROUND_CONTEXT);
    await until(async () => (await job(t))?.review?.status === "running");
    await until(() => models.waiting("unknown") === 1);
    expect(await leadCalls(t, "job_result", { job: 1 })).toBe(
      "job 1's result is under review; you get a notice when it is done.",
    );
    expect((await job(t))?.result?.pulledAt).toBeNull();
    models.release("unknown");
    await until(async () => (await job(t))?.review?.status === "passed");
  });
});
