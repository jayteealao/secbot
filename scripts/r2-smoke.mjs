#!/usr/bin/env node
// mise run smoke:r2 — proves the bucket refuses a second create of the same key before celld
// replication is turned on: PUT with If-None-Match: * must succeed once, then return 412.
// Reads R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY from the environment
// (the owner's shell, from the OpenTofu outputs); prints none of them.
import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";

const required = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`smoke:r2: set ${missing.join(", ")} in your shell first`);
  process.exit(1);
}

const client = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});
const url = `${process.env.R2_ENDPOINT.replace(/\/$/, "")}/${process.env.R2_BUCKET}/smoke/${randomUUID()}`;
const put = (body) => client.fetch(url, { method: "PUT", body, headers: { "If-None-Match": "*" } });

let ok = false;
try {
  const first = await put("first");
  const second = await put("second");
  console.log(`smoke:r2: first conditional PUT ${first.status}, second ${second.status}`);
  ok = first.ok && second.status === 412;
} finally {
  const removed = await client.fetch(url, { method: "DELETE" });
  if (!removed.ok) console.error(`smoke:r2: could not delete the smoke key (${removed.status})`);
}
if (!ok) {
  console.error(
    "smoke:r2: FAIL, the bucket did not refuse the second create with 412; keep replication off",
  );
  process.exit(1);
}
console.log("smoke:r2: PASS, the bucket refuses a second create (412)");
