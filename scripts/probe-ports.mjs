#!/usr/bin/env node
// mise run probe:ports — TCP probes of the celld ports from this machine. Every port must refuse
// or time out. Addresses come from the environment only:
//   SECBOT_PROBE_HOST   the address to probe (for example the VPS public address, from your shell)
//   SECBOT_PROBE_PORTS  comma-separated ports; default: every fleet's worker and internal port
import { connect } from "node:net";

const host = process.env.SECBOT_PROBE_HOST;
const ports = (process.env.SECBOT_PROBE_PORTS ?? "8787,8081,8788,8082,8789,8083")
  .split(",")
  .map(Number);
if (!host) {
  console.error("probe:ports: set SECBOT_PROBE_HOST in your shell first");
  process.exit(1);
}

const probe = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 5000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve("open");
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve("filtered");
    });
    socket.once("error", (error) =>
      resolve(error.code === "ECONNREFUSED" ? "refused" : `error ${error.code}`),
    );
  });

let open = 0;
for (const port of ports) {
  const result = await probe(port);
  // The host stays out of the log; the port and the result are enough.
  console.log(`probe:ports: port ${port}: ${result}`);
  if (result === "open") open++;
}
if (open > 0) {
  console.error(`probe:ports: FAIL, ${open} port(s) accept connections from this network`);
  process.exit(1);
}
console.log("probe:ports: PASS, every probed port refused or dropped the connection");
