// The process crash.test.ts kills with SIGKILL while a call is held for the person. It opens a
// person cell on a file-backed stand-in, adds a person ask-first rule for the lead's hand-off,
// submits a chat line the faux model answers with a hand-off call, waits until the call is held
// (its record committed), prints one READY line, and waits to be killed.
//   node --experimental-transform-types --no-warnings test/approval-crash-child.ts <database file>
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { approvalCrashResponder, CRASH_HANDOFF } from "./approval-crash-script.ts";
import { createFauxGateway, openTestCell } from "./fixtures.ts";

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: approval-crash-child.ts <database file>");

const log = console.log;
console.log = () => {};
const storage = new FakeCelldStorage({ file });
const t = await openTestCell({ storage, gateway: createFauxGateway(approvalCrashResponder) });
await t.cell.addRule("person", { agent: "lead", tool: "handoff", verdict: "ask-first" });
await t.cell.submit(CRASH_HANDOFF, "req-approval-crash");
let held = await t.cell.heldCalls();
while (held.length === 0) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  held = await t.cell.heldCalls();
}
log(`READY ${JSON.stringify({ number: held[0]?.number, requestId: held[0]?.requestId })}`);
await new Promise(() => {});
