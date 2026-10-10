/**
 * One harness on a cell's storage, for every cell that opens a pi-durable harness itself: the
 * secrets cell, the household cell, and the test-cell lab and bench. When an error shows that the
 * harness can never work again (`needsReopen`: a poisoned session, a closed driver, or celld
 * closed the cell's database), the slot logs one `cell.reopen` line, closes the harness, and the
 * next request opens a new one on the same storage.
 *
 * Without this, a harness whose database celld closed keeps retrying its running work and logs
 * the same error without end (celld v0.6.1 gives a cell back and closes its database while the
 * cell's JavaScript still runs; see `CELL_DATABASE_GONE`). Closing the harness stops that loop at
 * once: pi-durable seals its scheduler and aborts every invocation when the close starts, even when
 * the rest of the close never finishes. The person cell has its own form of this path
 * (`PersonCell.reopenAfter`), tied to its snapshot and restore steps.
 */
import { needsReopen } from "@secbot/cell-storage";
import { errorFields, logEvent } from "./cell-parts.ts";

/** How long a new open waits for the broken harness to close. */
export const SLOT_CLOSE_WAIT_MS = 10_000;

export type OpenHarness<T> = (onReport: (error: unknown) => void) => Promise<T>;

/** `T` is the opened harness, or a cell's own object that owns one and closes it. */
export class HarnessSlot<T extends { close(): Promise<void> }> {
  private opening: Promise<T> | undefined;
  private closing: Promise<void> | undefined;
  private generation = 0;

  constructor(
    private readonly cell: string,
    private readonly open: OpenHarness<T>,
    private readonly waitUntil?: (promise: Promise<unknown>) => void,
  ) {}

  /** The open harness, or a new one when none is open (after a broken one has closed). */
  get(): Promise<T> {
    if (this.opening === undefined) {
      const generation = ++this.generation;
      const opening = (this.closing ?? Promise.resolve()).then(() =>
        this.open((error) => this.lost(error, generation)),
      );
      this.opening = opening;
      opening.catch(() => {
        if (this.opening === opening) this.opening = undefined;
      });
    }
    return this.opening;
  }

  /** The harness that is open or opening now, if any; never opens one. */
  current(): Promise<T> | undefined {
    return this.opening;
  }

  /**
   * Closes the harness when `error` shows it can never work again. `generation` names the harness
   * the error came from; an error from an older harness, or a second error from the same one,
   * changes nothing.
   */
  lost(error: unknown, generation = this.generation): void {
    const opening = this.opening;
    if (!needsReopen(error) || generation !== this.generation || opening === undefined) return;
    this.opening = undefined;
    logEvent("cell.reopen", { cell: this.cell, ...errorFields(error) }, "warn");
    const closed = opening.then((cell) => cell.close()).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SLOT_CLOSE_WAIT_MS);
    });
    const closing: Promise<void> = Promise.race([closed, waited]).then(() => {
      clearTimeout(timer);
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    this.waitUntil?.(closing);
  }

  /** Closes the harness (a restore, a wipe, or tests); an open that failed has nothing to close. */
  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) await (await opening.catch(() => undefined))?.close();
    await this.closing;
  }
}
