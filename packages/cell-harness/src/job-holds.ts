/**
 * Job holds: a paused job, or a job waiting for an answer to its question, waits here in memory
 * with no model request and no spend, and with no time limit (D-020). Each wait re-reads the job's
 * row on every wake and ends when its check no longer holds; an abort of the waiting task rejects
 * it. pi-durable has no external-signal API, so a restart reruns the hook or the tool that waited,
 * which reads the row and waits again (the pattern of `BudgetGate.pause`, without the timer).
 */
import type { Context } from "@earendil-works/chord";

export class JobHolds {
  private readonly waiters = new Map<number, Set<() => void>>();

  /** Something about job `n` changed (a lead move, an answer): each of its waits checks again. */
  wake(n: number): void {
    const waiting = this.waiters.get(n);
    if (waiting === undefined) return;
    this.waiters.delete(n);
    for (const resume of waiting) resume();
  }

  /** How many waits job `n` has now. */
  waiting(n: number): number {
    return this.waiters.get(n)?.size ?? 0;
  }

  /** Waits while `check` holds, checking again on each wake of job `n`; rejects on abort. */
  async waitWhile(n: number, check: () => Promise<boolean>, context: Context): Promise<void> {
    for (;;) {
      context.abortSignal?.throwIfAborted();
      if (!(await check())) return;
      await this.pause(n, context);
    }
  }

  private pause(n: number, context: Context): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = context.abortSignal;
      const waiting = this.waiters.get(n) ?? new Set<() => void>();
      this.waiters.set(n, waiting);
      const finish = (settle: () => void) => {
        waiting.delete(resume);
        if (waiting.size === 0 && this.waiters.get(n) === waiting) this.waiters.delete(n);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const resume = () => finish(resolve);
      const onAbort = () => finish(() => reject(signal?.reason ?? new Error("aborted")));
      waiting.add(resume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
