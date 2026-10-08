/**
 * `secbot device new <name>`: makes this machine's device key. The key stays in the device file
 * (mode 0600); the CLI prints only the `name:person:sha256` line the owner adds to the cell's
 * runtime settings on the VPS. Removing that line and redeploying revokes the key.
 */
import { createHash, randomBytes } from "node:crypto";
import { CliError, type Environment, writeDevice } from "../config.ts";
import type { Io } from "../io.ts";

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

export async function deviceNew(
  environment: Environment,
  io: Io,
  name: string | undefined,
  person = "owner",
): Promise<number> {
  if (name === undefined || !NAME.test(name)) {
    throw new CliError(
      "usage: secbot device new <name> (letters, digits, dot, dash, underscore)",
      2,
    );
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(person)) throw new CliError(`bad person "${person}"`, 2);
  const key = randomBytes(32).toString("base64url");
  const path = await writeDevice(environment, { name, person, key });
  const hash = createHash("sha256").update(key).digest("hex");
  io.stdout(`device key saved to ${path}\n`);
  io.stdout("add this line to SECBOT_DEVICE_KEYS in the cell's runtime settings, then redeploy:\n");
  io.stdout(`${name}:${person}:${hash}\n`);
  return 0;
}
