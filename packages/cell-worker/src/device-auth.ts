/**
 * The device-key check on every CLI request. celld authenticates nothing, so the worker does.
 *
 * - The request must be addressed to one of the cell's private host names (SECBOT_PRIVATE_HOSTS).
 *   celld does not pass the client address to the worker (celld v0.6.1 crates/celld/main.rs:3178),
 *   so the Host check is the cell's own refusal; the bind address and firewall refuse outside
 *   connections before they reach it.
 * - `Authorization: Bearer <key>`: the key's SHA-256 must match an entry of SECBOT_DEVICE_KEYS
 *   (`name:person:sha256hex`, separated by commas or whitespace). A removed entry is a revoked key.
 * - The key's person must be the cell's person.
 *
 * Each refusal logs `cli.refused` with the reason and the device name, never the key, its hash, or
 * the full host name.
 */

export interface DeviceEnv {
  readonly SECBOT_DEVICE_KEYS?: string;
  readonly SECBOT_PRIVATE_HOSTS?: string;
}

export type RefusalReason = "not_private_host" | "missing_key" | "unknown_key" | "other_person";

export type DeviceCheck =
  | { readonly ok: true; readonly device: string }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: RefusalReason };

interface DeviceEntry {
  readonly name: string;
  readonly person: string;
  readonly hash: string;
}

const ENTRY = /^([A-Za-z0-9._-]{1,64}):([a-z][a-z0-9-]{0,31}):([0-9a-f]{64})$/;

export function parseDeviceKeys(value: string | undefined): DeviceEntry[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => ENTRY.exec(entry.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, name = "", person = "", hash = ""]) => ({ name, person, hash }));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two equal-length hex strings without an early exit. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

const hostName = (request: Request): string => {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  return host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
};

export async function checkDevice(
  request: Request,
  env: DeviceEnv,
  person: string,
): Promise<DeviceCheck> {
  const url = new URL(request.url);
  const host = hostName(request);
  let device: string | null = null;
  const refuse = (status: 401 | 403, reason: RefusalReason): DeviceCheck => {
    console.log(
      JSON.stringify({
        event: "cli.refused",
        cell: person,
        reason,
        device,
        route: url.pathname.split("/").slice(0, 4).join("/"),
        host_prefix: host.slice(0, 3),
      }),
    );
    return { ok: false, status, reason };
  };
  const privateHosts = (env.SECBOT_PRIVATE_HOSTS ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (!privateHosts.includes(host)) return refuse(403, "not_private_host");
  const header = request.headers.get("authorization") ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (key === undefined) return refuse(401, "missing_key");
  const hash = await sha256Hex(key);
  let found: DeviceEntry | undefined;
  for (const entry of parseDeviceKeys(env.SECBOT_DEVICE_KEYS)) {
    if (sameHex(entry.hash, hash) && found === undefined) found = entry;
  }
  if (found === undefined) return refuse(401, "unknown_key");
  device = found.name;
  if (found.person !== person) return refuse(403, "other_person");
  return { ok: true, device: found.name };
}
