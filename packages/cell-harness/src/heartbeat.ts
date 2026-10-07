/**
 * The heartbeat routine in every cell: a GET of the cell's Better Stack heartbeat URL every 240 s,
 * under the heartbeat's 300 s period and 60 s grace (infra/tofu/main.tf), which leaves room for a
 * bucket round trip and a late alarm. The ping URLs are identifiers, so they live only in the
 * runtime var `SECBOT_HEARTBEAT_URLS` filled on the VPS (`<key>:<url>` entries, comma separated;
 * the key is the cell name, or `<cell>.<routine>` for a routine's own heartbeat). No URL is ever
 * logged; a cell without one logs `skipped`.
 */
import { logEvent } from "./cell-parts.ts";
import { defineRoutine, type Routine, type RoutineHooks } from "./routines.ts";

export const HEARTBEAT_ROUTINE = "heartbeat";
export const HEARTBEAT_EVERY_MS = 240_000;
const PING_TIMEOUT_MS = 10_000;

export interface HeartbeatEnv {
  readonly SECBOT_HEARTBEAT_URLS?: string;
}

/** The ping URL for `key`, or undefined. Only https URLs are used. */
export function heartbeatUrl(env: HeartbeatEnv, key: string): string | undefined {
  for (const entry of (env.SECBOT_HEARTBEAT_URLS ?? "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    if (entry.slice(0, separator).trim() !== key) continue;
    const url = entry.slice(separator + 1).trim();
    return url.startsWith("https://") ? url : undefined;
  }
  return undefined;
}

export type PingOutcome = "ok" | "failed" | "skipped";

/**
 * Pings the heartbeat of `key` (a cell, or `<cell>.<routine>` for a later recurring routine such
 * as the morning briefing) and logs `heartbeat.ping`. Never throws.
 */
export async function pingRoutineHeartbeat(
  env: HeartbeatEnv,
  cell: string,
  routine: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  key: string = routine === HEARTBEAT_ROUTINE ? cell : `${cell}.${routine}`,
): Promise<PingOutcome> {
  const url = heartbeatUrl(env, key);
  if (url === undefined) {
    logEvent("heartbeat.ping", { cell, routine, outcome: "skipped", http_status: null });
    return "skipped";
  }
  let status: number | null = null;
  let outcome: PingOutcome = "failed";
  try {
    const response = await fetcher(url, {
      method: "GET",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    status = response.status;
    await response.body?.cancel();
    outcome = response.ok ? "ok" : "failed";
  } catch {
    outcome = "failed";
  }
  logEvent("heartbeat.ping", { cell, routine, outcome, http_status: status });
  return outcome;
}

/** The cell's heartbeat routine. A failed ping is logged; the next run is still 240 s later. */
export function createHeartbeatRoutine(
  env: HeartbeatEnv,
  hooks: RoutineHooks,
  fetcher?: typeof fetch,
): Routine {
  return defineRoutine(
    {
      name: HEARTBEAT_ROUTINE,
      every: HEARTBEAT_EVERY_MS,
      run: async (fire) => ({
        outcome: await pingRoutineHeartbeat(env, fire.cell, HEARTBEAT_ROUTINE, fetcher),
      }),
    },
    hooks,
  );
}
