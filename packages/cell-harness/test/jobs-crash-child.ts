// The process crash.test.ts kills with SIGKILL while the job board holds work in three states. It
// opens a person cell on a file-backed stand-in and starts three jobs in one lead turn: a research
// job that answers (its result waits on the board), a health job whose model call never answers in
// this process, and a developer job that waits on the developer budget before its first request.
// Then it forces a compaction of the lead (long messages, then `compact`), prints the board on one
// READY line, and waits to be killed.
//   node --experimental-transform-types --no-warnings test/jobs-crash-child.ts <database file>
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { addSpend, createFauxGateway, openTestCell } from "./fixtures.ts";
import { createHold, jobResponder, startJobLine } from "./responders.ts";

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: jobs-crash-child.ts <database file>");

/** The three jobs, as one lead turn's call lines. */
const THREE_JOBS = [
  startJobLine({ title: "fasting and sleep", brief: "Look into fasting.", template: "research" }),
  startJobLine({ title: "sleep plan", brief: "Make a sleep plan.", template: "health" }),
  startJobLine({ title: "fix the list", brief: "Fix the list.", template: "developer" }),
].join("\n");

const log = console.log;
console.log = () => {};
const hold = createHold();
hold.hold("health");
const storage = new FakeCelldStorage({ file });
const t = await openTestCell({ storage, gateway: createFauxGateway(hold.wrap(jobResponder)) });
// Over the developer budget: the developer job waits before its first request.
await addSpend(t.cell, 60, { role: "developer" });
await (await t.cell.submit(THREE_JOBS, "req-jobs-crash")).wait(BACKGROUND_CONTEXT);
const settle = async (done: () => Promise<boolean>) => {
  while (!(await done())) await new Promise((resolve) => setTimeout(resolve, 10));
};
await settle(async () => (await t.cell.board()).jobs["1"]?.result != null);
await settle(async () => hold.waiting("health") === 1);
await settle(async () => (await t.cell.waiting()).some((wait) => wait.what === "job 3 developer"));

// A compaction of the lead while the jobs are live.
const filler = "the weekly plan in detail. ".repeat(1_000);
for (const [index, text] of ["Cook kale soup", "Buy oat milk", "Clean the shed"].entries()) {
  await (await t.cell.submit(`${text}, and ${filler}`, `req-long-${index}`)).wait(
    BACKGROUND_CONTEXT,
  );
}
const compaction = await t.cell.root.compact(undefined, BACKGROUND_CONTEXT);
const { state } = await t.cell.harness.waitForTask(compaction, BACKGROUND_CONTEXT);
if (state.outcome.status === "completed" && state.outcome.result.submissionId !== undefined) {
  await (
    await t.cell.harness.submission(state.outcome.result.submissionId, BACKGROUND_CONTEXT)
  )?.wait(BACKGROUND_CONTEXT);
}
const page = await t.cell.root.entries({}, 200, undefined, BACKGROUND_CONTEXT);
const compacted = page.items.some((entry) => entry.kind === "pi.compaction");
log(`READY ${JSON.stringify({ board: await t.cell.board(), compacted })}`);
await new Promise(() => {});
