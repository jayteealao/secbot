import { CellStorageClosedError } from "./celld-sqlite-database.ts";

/** pi-durable's message for a session that a failed commit poisoned (session.js, assertHealthy). */
export const POISONED_SESSION = "Session is poisoned by a failed commit after storage admission";

/**
 * True when a harness can never work again on its current session: pi-durable poisoned it, or a
 * reset closed the storage driver under it. Only a new harness on the same storage clears either.
 */
export function needsReopen(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof CellStorageClosedError) return true;
    if (current.message.includes(POISONED_SESSION)) return true;
    current = current.cause;
  }
  return false;
}
