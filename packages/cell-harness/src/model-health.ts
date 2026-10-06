/**
 * Model health: one state per cell (ok, failing, credit) in the `secbot.model-health` document.
 *
 * The telemetry hook reports every terminal provider message here. Hooks may read but not commit
 * (pi-durable v1.0.3 src/harness/types.ts:604-610), so the monitor queues its commits on the host
 * side, one at a time, outside the hook's call stack. The first failure time is durable in the
 * document, so a restart keeps counting the outage from its start.
 *
 * - failing for 15 minutes: one outage alert, and sessions show "waiting for the model";
 * - a credit error: one credit alert at once, and the waiting state;
 * - a success: back to ok, the waiting state clears, and the recovery is logged.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { AlertKind, Alerts } from "./alerts.ts";
import { logEvent } from "./cell-parts.ts";
import { ModelHealthDoc } from "./docs.ts";

export const OUTAGE_ALERT_AFTER_MS = 15 * 60_000;

export type HealthReport =
  | { readonly kind: "failure"; readonly error: string; readonly credit: boolean }
  | { readonly kind: "success" };

export class ModelHealthMonitor {
  private chain: Promise<void> = Promise.resolve();
  private harness: Harness | undefined;

  constructor(
    private readonly options: {
      readonly person: string;
      readonly alerts: Alerts;
      readonly now: () => number;
      readonly onReport: (error: unknown) => void;
    },
  ) {}

  attach(harness: Harness): void {
    this.harness = harness;
  }

  /** Queues a report; never throws and never blocks the caller. */
  report(report: HealthReport): void {
    this.chain = this.chain
      .then(() => this.apply(report))
      .catch((error: unknown) => this.options.onReport(error));
  }

  /** Resolves once every queued report is applied (tests and shutdown). */
  settled(): Promise<void> {
    return this.chain;
  }

  private async apply(report: HealthReport): Promise<void> {
    const harness = this.harness;
    if (harness === undefined) return;
    const { person, now } = this.options;
    const at = now();
    const alert = await harness.commit(async (tx): Promise<AlertKind | undefined> => {
      const health = await tx.doc(ModelHealthDoc);
      if (report.kind === "success") {
        if (health.state !== "ok") {
          logEvent("model.health", {
            cell: person,
            state: "ok",
            since: health.since,
            failing_ms: health.since === null ? 0 : at - health.since,
            last_error: health.lastError,
          });
        }
        Object.assign(health, {
          state: "ok",
          since: null,
          lastError: "",
          alertedAt: null,
          waiting: false,
        });
        return undefined;
      }
      const lastError = report.error.slice(0, 200);
      const next = report.credit ? "credit" : health.state === "credit" ? "credit" : "failing";
      if (health.state !== next) {
        if (health.since === null) health.since = at;
        health.state = next;
        logEvent("model.health", {
          cell: person,
          state: next,
          since: health.since,
          failing_ms: at - health.since,
          last_error: lastError,
        });
      }
      health.lastError = lastError;
      const since = health.since ?? at;
      if (health.alertedAt !== null) return undefined;
      if (next === "credit") {
        Object.assign(health, { alertedAt: at, waiting: true });
        return "credit";
      }
      if (at - since >= OUTAGE_ALERT_AFTER_MS) {
        Object.assign(health, { alertedAt: at, waiting: true });
        return "outage";
      }
      return undefined;
    }, BACKGROUND_CONTEXT);
    if (alert === undefined) return;
    if (!(await this.options.alerts.send(alert))) {
      // Not sent: the next failure tries again; the waiting state stays on.
      await harness.commit(async (tx) => {
        (await tx.doc(ModelHealthDoc)).alertedAt = null;
      }, BACKGROUND_CONTEXT);
    }
  }
}
