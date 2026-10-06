/**
 * Owner alerts through a Better Stack incident (push and email). API: `POST /api/v3/incidents` on
 * incidents.betterstack.com with a bearer token; `summary` and `requester_email` are required
 * (https://betterstack.com/docs/uptime/api/create-a-new-incident/, read 2026-10-06). The token and
 * the e-mail are cell vars filled on the VPS at deploy time; neither is ever logged.
 */
import { logEvent } from "./cell-parts.ts";

export type AlertKind = "outage" | "credit";

export interface AlertEnv {
  readonly BETTERSTACK_INCIDENTS_TOKEN?: string;
  readonly BETTERSTACK_REQUESTER_EMAIL?: string;
  /** Tests only: a local stub's origin. */
  readonly BETTERSTACK_BASE_URL?: string;
}

export interface Alerts {
  /** Resolves true when the incident was created (or skipped for want of a token). */
  send(kind: AlertKind): Promise<boolean>;
}

export const ALERT_SUMMARIES: Record<AlertKind, (person: string) => string> = {
  outage: (person) => `Secbot ${person} cell: waiting for the model for 15 minutes`,
  credit: (person) => `Secbot ${person} cell: model credit limit reached`,
};

const DESCRIPTIONS: Record<AlertKind, string> = {
  outage:
    "Model calls through OpenRouter have failed for 15 minutes. Requests are kept and retried every minute; nothing is lost. See docs/runbooks/model-outage.md.",
  credit:
    "The OpenRouter key's credit limit is reached. Requests are kept and retried every minute; raise the limit to resume. See docs/runbooks/model-outage.md.",
};

export function createAlerts(
  env: AlertEnv,
  person: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Alerts {
  const base = env.BETTERSTACK_BASE_URL || "https://incidents.betterstack.com";
  return {
    async send(kind) {
      const token = env.BETTERSTACK_INCIDENTS_TOKEN;
      const email = env.BETTERSTACK_REQUESTER_EMAIL;
      if (!token || !email) {
        logEvent("model.alert", { cell: person, kind, outcome: "skipped", http_status: null });
        return true;
      }
      try {
        const response = await fetcher(`${base}/api/v3/incidents`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            summary: ALERT_SUMMARIES[kind](person),
            name: ALERT_SUMMARIES[kind](person),
            description: DESCRIPTIONS[kind],
            requester_email: email,
            push: true,
            email: true,
          }),
        });
        const ok = response.ok;
        logEvent("model.alert", {
          cell: person,
          kind,
          outcome: ok ? "sent" : "failed",
          http_status: response.status,
        });
        return ok;
      } catch {
        logEvent("model.alert", { cell: person, kind, outcome: "failed", http_status: null });
        return false;
      }
    },
  };
}
