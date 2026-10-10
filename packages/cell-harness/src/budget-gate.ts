/**
 * The budget gate: above a limit, only direct chat with the lead runs. Hand-off deliveries and
 * reports, routine runs (every reminder included), and the next model request of a specialist's
 * running job wait here until the owner raises the limit or the month resets; nothing is dropped.
 * The lead's conversation never passes the gate, and neither does the guard: a guard call costs
 * money, and safety wins over the limit.
 *
 * A wait lists its task in `secbot.budget-waits` (what, since when), so the activity view and the
 * limit notice can show it and the wake-time reader can time it at the month reset; then it waits
 * in memory for a limit or settings change, the month reset, or the task's abort. pi-durable has no
 * external-signal API, so a restart reruns the phase or the hook, which checks again.
 *
 * A specialist's step is one model request and the tool calls it made: the `secbot-budget`
 * extension waits in `GenerationTask.beforeRequest`, which runs before every request attempt
 * (installed pi-durable 1.0.3, dist/harness/types.d.ts:539-545; dist/harness/generation.js:108).
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { SetTimer } from "./approvals.ts";
import { logEvent } from "./cell-parts.ts";
import { type BudgetName, BudgetWaitsDoc } from "./docs.ts";
import type { BudgetState } from "./limits.ts";
import { budgetOf } from "./month-ledger.ts";
import { redactText } from "./redact.ts";
import { roleOf } from "./telemetry.ts";

/** One piece of work that waits above a limit. */
export interface WaitRequest {
  readonly budget: BudgetName;
  /** The waiting task (one entry per task). */
  readonly taskId: string;
  /** What people see in the waiting list, for example `handoff research train times`. */
  readonly what: string;
}

/** What hand-offs, routines, and specialist jobs wait on. */
export interface BudgetWaiter {
  /** Returns at once under the limit; otherwise waits until the budget is under it again. */
  waitUntilUnder(request: WaitRequest, context: Context): Promise<void>;
  /** True while the budget is at or above its limit. */
  isOver(budget: BudgetName, context: Context): Promise<boolean>;
}

/** The waiting text: at most `limit` characters of `text`, redacted, on one line. */
export function shortText(text: string, limit = 30): string {
  const flat = redactText(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit).trimEnd() : flat;
}

export interface BudgetGateOptions {
  readonly person: string;
  readonly harness: () => Harness;
  /** Both budgets now (reads the ledger; rolls the month when it ended). */
  readonly state: (context: Context) => Promise<BudgetState>;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  /** A wait started or ended: the cell re-arms its alarm. */
  readonly onWakeChange?: () => void;
}

export class BudgetGate implements BudgetWaiter {
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: BudgetGateOptions) {}

  /** A limit, a household setting, or the month changed: every wait checks again. */
  wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resume of waiting) resume();
  }

  async isOver(budget: BudgetName, context: Context): Promise<boolean> {
    return (await this.options.state(context))[budget].line === "over";
  }

  async waitUntilUnder(request: WaitRequest, context: Context): Promise<void> {
    const { harness, person } = this.options;
    let listed = false;
    try {
      for (;;) {
        context.abortSignal?.throwIfAborted();
        const state = await this.options.state(context);
        if (state[request.budget].line !== "over") {
          // An entry an earlier run listed (a restart aborted its wait) ends here too.
          if (!listed) {
            const waits = await harness().snapshot(BudgetWaitsDoc, context);
            listed = waits?.tasks[request.taskId] !== undefined;
          }
          return;
        }
        if (!listed) {
          await harness().commit(async (tx) => {
            const waits = await tx.doc(BudgetWaitsDoc);
            const since = waits.tasks[request.taskId]?.since ?? this.options.now();
            waits.tasks[request.taskId] = { budget: request.budget, what: request.what, since };
          }, context);
          listed = true;
          logEvent("budget.wait", {
            cell: person,
            budget: request.budget,
            task_id: request.taskId,
            phase: "start",
          });
          this.options.onWakeChange?.();
        }
        await this.pause(state.spend.resetsAt - this.options.now(), context);
      }
    } finally {
      if (listed) {
        const quiet = withoutAbortSignal(context);
        const aborted = context.abortSignal?.aborted === true;
        // An abort from a closing harness leaves the entry: the rerun after the reopen lists it again.
        await harness()
          .commit(async (tx) => {
            delete (await tx.doc(BudgetWaitsDoc)).tasks[request.taskId];
          }, quiet)
          .then(() => {
            logEvent("budget.wait", {
              cell: person,
              budget: request.budget,
              task_id: request.taskId,
              phase: aborted ? "aborted" : "end",
            });
            this.options.onWakeChange?.();
          })
          .catch(() => {});
      }
    }
  }

  /** Resolves on `wake()` or after `ms`; rejects when the context aborts. */
  private pause(ms: number, context: Context): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = context.abortSignal;
      let cancel: () => void = () => {};
      const finish = (settle: () => void) => {
        this.waiters.delete(resume);
        cancel();
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const resume = () => finish(resolve);
      const onAbort = () => finish(() => reject(signal?.reason ?? new Error("aborted")));
      this.waiters.add(resume);
      // A little past the reset, so the clock has passed it when the check runs.
      cancel = this.options.setTimer(Math.max(0, ms) + 1_000, resume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * The `secbot-budget` extension, on every specialist's list (after the guard) and never on the
 * lead's: before each model request of a specialist's job, wait while its budget is over the
 * limit (the developer specialist on the developer budget, every other one on the person's).
 */
export function createBudgetExtension(gate: () => BudgetWaiter | undefined): Extension {
  return defineExtension({
    name: "secbot-budget",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          if (api.conversationId === ROOT_CONVERSATION_ID) return undefined;
          const waiter = gate();
          if (waiter === undefined) return undefined;
          const role = await roleOf(api, api.conversationId, context);
          await waiter.waitUntilUnder(
            { budget: budgetOf(role), taskId: String(api.taskId), what: `job ${role}` },
            context,
          );
          return undefined;
        },
      }),
    ],
  });
}
