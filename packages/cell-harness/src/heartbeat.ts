/**
 * The heartbeat routine in every cell: a GET of the cell's Better Stack heartbeat URL every 240 s,
 * under the heartbeat's 300 s period and 60 s grace (infra/tofu/main.tf), which leaves room for a
 * bucket round trip and a late alarm. The ping URLs are identifiers, so they live only in the
 * runtime var `SECBOT_HEARTBEAT_URLS` filled on the VPS (`<key>:<url>` entries, comma separated;
 * the key is the cell name, or `<cell>.<routine>` for a routine's own heartbeat). No URL is ever
 * logged; a cell without one logs `skipped`.
 *
 * After each run the routine commits `secbot.heartbeat` (the last run, its outcome and HTTP status,
 * and the last 2xx ping time) in the same commit as its next wake time, so `check:heartbeats` can
 * tell a fresh ping since a deploy from a stale one without reading Better Stack. No URL is stored.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
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

export type HeartbeatState = {
  /** The last run, epoch milliseconds. */
  lastAt: number | null;
  lastOutcome: PingOutcome | null;
  /** The last run whose ping answered 2xx. */
  lastOkAt: number | null;
  lastHttpStatus: number | null;
};

/** `secbot.heartbeat`: the heartbeat routine's last run, for the operator route. */
export const HeartbeatDoc = defineDoc<HeartbeatState>({
  kind: "secbot.heartbeat",
  version: 1,
  scope: "session",
  initial: () => ({ lastAt: null, lastOutcome: null, lastOkAt: null, lastHttpStatus: null }),
});

/** The cell's stored heartbeat state; all null before the first run. */
export async function heartbeatState(
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
): Promise<HeartbeatState> {
  return (
    (await harness.snapshot(HeartbeatDoc, context)) ?? {
      lastAt: null,
      lastOutcome: null,
      lastOkAt: null,
      lastHttpStatus: null,
    }
  );
}

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
  return (await pingHeartbeat(env, cell, routine, fetcher, key)).outcome;
}

async function pingHeartbeat(
  env: HeartbeatEnv,
  cell: string,
  routine: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  key: string = routine === HEARTBEAT_ROUTINE ? cell : `${cell}.${routine}`,
): Promise<{ outcome: PingOutcome; status: number | null }> {
  const url = heartbeatUrl(env, key);
  if (url === undefined) {
    logEvent("heartbeat.ping", { cell, routine, outcome: "skipped", http_status: null });
    return { outcome: "skipped", status: null };
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
  return { outcome, status };
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
      // The liveness ping makes no model call; it runs above a limit, so the owner's monitor never
      // reads a paused heartbeat as an outage.
      spends: false,
      run: async (fire) => {
        const { outcome, status } = await pingHeartbeat(env, fire.cell, HEARTBEAT_ROUTINE, fetcher);
        const at = fire.runtime.now();
        return {
          outcome,
          record: async (tx) => {
            const doc = await tx.doc(HeartbeatDoc);
            doc.lastAt = at;
            doc.lastOutcome = outcome;
            doc.lastHttpStatus = status;
            if (outcome === "ok") doc.lastOkAt = at;
          },
        };
      },
    },
    hooks,
  );
}
