// The process crash.test.ts kills with SIGKILL while a tool call's beforeTool hook waits. It opens
// the probe harness on a file-backed stand-in, submits one message that the faux model answers
// with a call to the probe tool of the given replay policy, waits until the hook has run (and its
// memo is committed), prints one READY line, and waits to be killed.
//   node --experimental-transform-types --no-warnings test/hook-crash-child.ts <database file> <safe|unsafe>
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { createFauxGateway } from "./fixtures.ts";
import {
  createHookProbe,
  openProbeHarness,
  probeResponder,
  type ReplayPolicy,
  waitForever,
} from "./hook-crash-probe.ts";

const [file, policy] = process.argv.slice(2);
if (file === undefined || (policy !== "safe" && policy !== "unsafe")) {
  throw new Error("usage: hook-crash-child.ts <database file> <safe|unsafe>");
}
const replay: ReplayPolicy = policy;

const log = console.log;
console.log = () => {};
const probe = createHookProbe(waitForever);
const gateway = createFauxGateway(probeResponder(replay));
const storage = new FakeCelldStorage({ file });
const { harness, root } = await openProbeHarness(storage, gateway, probe);
harness.resume();
await root.submit(
  { type: "input", content: "run the probe", requestId: `req-hook-crash-${replay}` },
  BACKGROUND_CONTEXT,
);
while (probe.runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
const run = probe.runs[0];
log(
  `READY ${JSON.stringify({
    policy: replay,
    taskId: run?.taskId,
    callId: run?.callId,
    hookRuns: probe.runs.length,
    executions: probe.executions[replay],
    pid: process.pid,
  })}`,
);
await new Promise(() => {});
