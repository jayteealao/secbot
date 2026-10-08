// The process crash.test.ts kills with SIGKILL. It opens a person cell's harness on a file-backed
// stand-in and sets up three things in flight: a specialist hand-off whose model call is cut off
// (it hangs in this process), a reminder ten minutes ahead, and an open transaction holding a
// marker row. Then it prints one READY line and waits to be killed.
//   node --experimental-transform-types --no-warnings test/crash-child.ts <database file>
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { openCellHarness } from "../src/open-harness.ts";
import { scheduleReminder } from "../src/reminder.ts";
import { createFauxGateway, type FauxRequest } from "./fixtures.ts";
import { handoffResponder } from "./responders.ts";

const file = process.argv[2];
if (file === undefined) throw new Error("usage: crash-child.ts <database file>");

let specialistCalls = 0;
const gateway = createFauxGateway(async (request: FauxRequest) => {
  if (request.role === "research") {
    specialistCalls++;
    // The cut-off call: it never answers in this process.
    await new Promise(() => {});
  }
  return handoffResponder(request);
});
const log = console.log;
console.log = () => {};
const storage = new FakeCelldStorage({ file });
const cell = await openCellHarness(storage, {
  person: "owner",
  version: "v0.0.0-crash",
  env: {},
  models: gateway.models,
});
await cell.submit("Find out about fasting for me", "req-crash-0001");
while (specialistCalls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
const reminderAt = Date.now() + 10 * 60_000;
const reminderTaskId = await scheduleReminder(
  cell.harness,
  cell.reminders,
  "crash:1",
  reminderAt,
  "check the oven",
  BACKGROUND_CONTEXT,
);
const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
void cell.database.transaction(async (tx) => {
  await tx.exec("CREATE TABLE IF NOT EXISTS crash_marker (id INTEGER PRIMARY KEY, at INTEGER)");
  await tx.run("INSERT INTO crash_marker (at) VALUES (?)", Date.now());
  markOpened();
  await new Promise(() => {});
});
await opened;
log(
  `READY ${JSON.stringify({ reminderTaskId: String(reminderTaskId), reminderAt, specialistCalls })}`,
);
await new Promise(() => {});
