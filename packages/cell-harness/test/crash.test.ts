// A crash with a real SIGKILL (the local half; the test cell repeats it on real celld
// storage with test:durability). A child process holds a running specialist job whose model call
// is mid-flight, an open transaction with a marker row, and a pending reminder; it is killed with
// SIGKILL. A new harness on the same database file then shows: the conversation intact, no
// marker row (no partial write), the reminder pending with the same wake time, the alarm set
// again from the stored timers, and the cut-off model call sent again so the turn completes.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { CellAlarm } from "../src/alarm.ts";
import { leadMessageOf } from "../src/delivery.ts";
import { messageText } from "../src/history-search.ts";
import { routineWake } from "../src/routines.ts";
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import {
  createHookProbe,
  FIRST_RUN_MEMO,
  openProbeHarness,
  PROBE_TOOLS,
  pass,
  probeResponder,
  type ReplayPolicy,
} from "./hook-crash-probe.ts";
import { handoffResponder } from "./responders.ts";

const here = dirname(fileURLToPath(import.meta.url));

let test: TestCell | undefined;
let probeCell: { harness: Harness; storage: FakeCelldStorage } | undefined;
let directory: string | undefined;
afterEach(async () => {
  await test?.cell.close();
  test?.storage.closeFile();
  test = undefined;
  await probeCell?.harness.close(BACKGROUND_CONTEXT);
  probeCell?.storage.closeFile();
  probeCell = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

interface Ready {
  readonly reminderTaskId: string;
  readonly reminderAt: number;
  readonly specialistCalls: number;
}

/** Runs `script` (in this folder) until it prints its READY line; `kill` ends it with SIGKILL. */
function runChildUntilReady<T>(
  script: string,
  args: readonly string[],
): Promise<{ ready: T; kill: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", join(here, script), ...args],
    { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the child never got ready: ${errors.slice(-2000)}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const line = output.split("\n").find((text) => text.startsWith("READY "));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve({
        ready: JSON.parse(line.slice(6)) as T,
        kill: async () => {
          child.kill("SIGKILL");
          await exited;
        },
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!output.includes("READY ")) {
        reject(
          new Error(`the child exited (${code ?? signal}) before READY: ${errors.slice(-2000)}`),
        );
      }
    });
  });
}

describe("a SIGKILL with a running job, an open transaction, and a pending timer", () => {
  it("keeps the conversation, drops the partial write, keeps the timer, re-arms, and reruns the cut-off call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    directory = await mkdtemp(join(tmpdir(), "secbot-crash-"));
    const file = join(directory, "cell.sqlite");
    const { ready, kill } = await runChildUntilReady<Ready>("crash-child.ts", [file]);
    expect(ready.specialistCalls).toBe(1);
    await kill();

    const storage = new FakeCelldStorage({ file });
    // No partial write: the marker table and row of the open transaction are gone.
    const marker = storage.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crash_marker'")
      .all();
    expect(marker).toEqual([]);

    const gateway = createFauxGateway(handoffResponder);
    test = await openTestCell({ storage, gateway });
    const t = test;

    // The conversation is intact.
    const firstPage = await t.cell.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const userTexts = firstPage.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) => messageText(entry.model?.[0]));
    expect(userTexts).toContain("Find out about fasting for me");

    // The pending reminder survived with its wake time.
    const reminders = (await t.cell.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === "secbot.routine:reminder",
    );
    expect(reminders.map(({ record }) => String(record.id))).toEqual([ready.reminderTaskId]);
    const reminder = reminders[0]?.record;
    expect(
      routineWake(reminder?.state.status === "terminal" ? undefined : reminder?.state.checkpoint),
    ).toBe(ready.reminderAt);

    // The cut-off model call runs again and the turn completes: the specialist's answer returns
    // to the lead, which relays it.
    await until(async () => {
      const page = await t.cell.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      return page.items.some((entry) => leadMessageOf(entry)?.text.startsWith("Research says"));
    }, 30_000);
    expect(gateway.requests.filter((request) => request.role === "research")).toHaveLength(1);

    // The alarm is set again from the stored timers: equal to the earliest stored wake time.
    await until(async () => (await t.cell.wakes()).summary.liveUntimed === 0, 30_000);
    const alarms = new CellAlarm(storage, "owner");
    await alarms.rearm(t.cell);
    const { summary } = await t.cell.wakes();
    expect(await storage.getAlarm()).toBe(summary.wakes[0]?.at);
    expect(summary.wakes.map((wake) => wake.source).sort()).toEqual(["heartbeat", "reminder"]);
    expect((await alarms.report(t.cell)).ok).toBe(true);
  }, 120_000);
});

// A SIGKILL while a tool call's beforeTool hook waits (the approval hold's crash case). pi-durable
// commits the tool's intent checkpoint only after every beforeTool hook returns (dist/harness/
// tool.js:35-65 of the pinned 1.0.3), so a call killed inside its hook is still in the `call`
// phase: on reopen it becomes pending with that checkpoint (scheduler.js:79-95) and the whole
// phase runs again (scheduler.js:761), hook included. The replay rule in the `execute` phase
// (tool.js:68-87) is never reached, so a safe and an unsafe tool behave the same. The hook's task
// memo survives, so the second run finds the first run's record.
interface HookReady {
  readonly policy: ReplayPolicy;
  readonly taskId: string;
  readonly callId: string;
  readonly hookRuns: number;
  readonly executions: number;
  readonly pid: number;
}

describe("a SIGKILL while a beforeTool hook waits", () => {
  it.each<ReplayPolicy>(["safe", "unsafe"])(
    "runs the %s tool's hook again from the start after the restart, with its memo kept",
    async (policy) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      directory = await mkdtemp(join(tmpdir(), "secbot-hook-crash-"));
      const file = join(directory, "cell.sqlite");
      const { ready, kill } = await runChildUntilReady<HookReady>("hook-crash-child.ts", [
        file,
        policy,
      ]);
      expect(ready).toMatchObject({ policy, hookRuns: 1, executions: 0 });
      await kill();

      const storage = new FakeCelldStorage({ file });
      const gateway = createFauxGateway(probeResponder(policy));
      const probe = createHookProbe(pass);
      const { harness, root } = await openProbeHarness(storage, gateway, probe);
      probeCell = { harness, storage };

      // Before resume(): the tool task as the crash left it.
      const task = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
        ({ record }) => String(record.id) === ready.taskId,
      )?.record;
      const live = task?.state.status === "terminal" || task?.state.status === "completing";
      expect({
        kind: task?.kind,
        status: task?.state.status,
        checkpoint: live || task === undefined ? undefined : task.state.checkpoint,
        memo: live ? undefined : task?.memos?.[FIRST_RUN_MEMO],
      }).toEqual({
        kind: "pi.tool",
        status: "pending",
        checkpoint: { phase: "call" },
        memo: { pid: ready.pid, callId: ready.callId },
      });

      // After resume(): the call settles, and the turn ends.
      harness.resume();
      const resultOf = async () => {
        const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
        return page.items.find(
          (entry) =>
            entry.kind === "pi.tool-result" &&
            (entry.model?.[0] as { toolCallId?: string } | undefined)?.toolCallId === ready.callId,
        );
      };
      await until(async () => (await resultOf()) !== undefined, 30_000);
      const entry = await resultOf();
      const message = entry?.model?.[0] as (Message & { isError?: boolean }) | undefined;
      const diagnostics = (entry?.data as { diagnostics?: { code?: string }[] } | undefined)
        ?.diagnostics;
      expect({
        hookRuns: probe.runs.length,
        hookCallIds: probe.runs.map((run) => run.callId),
        hookTaskIds: probe.runs.map((run) => run.taskId),
        memoSeenBySecondRun: probe.runs.map((run) => run.memo),
        executions: probe.executions[policy],
        toolName: (message as { toolName?: string } | undefined)?.toolName,
        isError: message?.isError,
        diagnosticCodes: (diagnostics ?? []).map((diagnostic) => diagnostic.code),
      }).toEqual({
        hookRuns: 1,
        hookCallIds: [ready.callId],
        hookTaskIds: [ready.taskId],
        memoSeenBySecondRun: [{ pid: ready.pid, callId: ready.callId }],
        executions: 1,
        toolName: PROBE_TOOLS[policy],
        isError: false,
        diagnosticCodes: [],
      });
    },
    120_000,
  );
});
