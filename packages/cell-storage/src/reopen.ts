import { CellStorageClosedError } from "./celld-sqlite-database.ts";

/** pi-durable's message for a session that a failed commit poisoned (session.js, assertHealthy). */
export const POISONED_SESSION = "Session is poisoned by a failed commit after storage admission";

/**
 * celld's message for a cell whose database this isolate closed: celld gave the cell back (an idle
 * eviction, a stop, or a generation swap) while JavaScript that the cell started still runs. Every
 * storage call of that cell then fails with "no db for <scope>" and never heals in this instance.
 * source: celld v0.6.1 crates/celld/storage.rs `close()` and `with()`; js/bootstrap.rs
 * `finish_cell_adoption`; runtime.rs `stop_cell` and `swap_out_cell` (any cell class).
 */
export const CELL_DATABASE_GONE = /\bno db for \S+/;

/**
 * True when a harness can never work again on its current session: pi-durable poisoned it, a reset
 * closed the storage driver under it, or celld closed the cell's database. Only a new harness on
 * the same storage clears any of them.
 */
export function needsReopen(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof CellStorageClosedError) return true;
    if (current.message.includes(POISONED_SESSION)) return true;
    if (CELL_DATABASE_GONE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
