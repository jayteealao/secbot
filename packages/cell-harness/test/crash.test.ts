// AC-19 and AC-21 with a real SIGKILL (the local half; the test cell repeats it on real celld
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { CellAlarm } from "../src/alarm.ts";
import { leadMessageOf } from "../src/delivery.ts";
import { messageText } from "../src/history-search.ts";
import { routineWake } from "../src/routines.ts";
import { createFauxGateway, openTestCell, type TestCell, until } from "./fixtures.ts";
import { handoffResponder } from "./responders.ts";

const here = dirname(fileURLToPath(import.meta.url));

let test: TestCell | undefined;
let directory: string | undefined;
afterEach(async () => {
  await test?.cell.close();
  test?.storage.closeFile();
  test = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

interface Ready {
  readonly reminderTaskId: string;
  readonly reminderAt: number;
  readonly specialistCalls: number;
}

function runChildUntilReady(file: string): Promise<{ ready: Ready; kill: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", join(here, "crash-child.ts"), file],
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
        ready: JSON.parse(line.slice(6)) as Ready,
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
    const { ready, kill } = await runChildUntilReady(file);
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
