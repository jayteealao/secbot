/**
 * Owner alerts through a Better Stack incident (push and email). API: `POST /api/v3/incidents` on
 * incidents.betterstack.com with a bearer token; `summary` and `requester_email` are required
 * (https://betterstack.com/docs/uptime/api/create-a-new-incident/, read 2026-10-06). The token and
 * the e-mail are cell vars filled on the VPS at deploy time; neither is ever logged.
 */
import { errorFields, logEvent } from "./cell-parts.ts";

/** An incident call that does not answer in this time counts as failed, like the heartbeat ping. */
export const ALERT_TIMEOUT_MS = 10_000;

export type AlertKind = "outage" | "credit";

/** A limit line: 80% or 100% of a person's monthly limit or of the household developer budget. */
export interface LimitAlert {
  readonly budget: "person" | "developer";
  readonly line: number;
}

export interface AlertEnv {
  readonly BETTERSTACK_INCIDENTS_TOKEN?: string;
  readonly BETTERSTACK_REQUESTER_EMAIL?: string;
  /** Tests only: a local stub's origin. */
  readonly BETTERSTACK_BASE_URL?: string;
}

export interface Alerts {
  /** Resolves true when the incident was created (or skipped for want of a token). */
  send(kind: AlertKind): Promise<boolean>;
  /** The owner alert of one limit line; no amount and no private detail. */
  sendLimit(limit: LimitAlert): Promise<boolean>;
}

export const ALERT_SUMMARIES: Record<AlertKind, (person: string) => string> = {
  outage: (person) => `Secbot ${person} cell: waiting for the model for 15 minutes`,
  credit: (person) => `Secbot ${person} cell: model credit limit reached`,
};

const DESCRIPTIONS: Record<AlertKind, string> = {
  outage:
    "Model calls through OpenRouter have failed for 15 minutes. Requests are kept and retried, at most one minute apart; nothing is lost. See docs/runbooks/model-outage.md.",
  credit:
    "The OpenRouter key's credit limit is reached. Requests are kept and retried, at most one minute apart; raise the limit to resume. See docs/runbooks/model-outage.md.",
};

/** The summary of a limit line's alert. */
export function limitSummary(person: string, limit: LimitAlert): string {
  if (limit.budget === "developer") {
    return limit.line >= 100
      ? "Secbot household: developer budget reached"
      : `Secbot household: ${limit.line}% of the developer budget`;
  }
  return limit.line >= 100
    ? `Secbot ${person} cell: monthly limit reached`
    : `Secbot ${person} cell: ${limit.line}% of the monthly limit`;
}

/** What waits, and that nothing is dropped; never an amount. */
export function limitDescription(limit: LimitAlert): string {
  if (limit.budget === "developer") {
    return limit.line >= 100
      ? "Developer jobs wait until you raise the developer budget (secbot limits developer <usd>) or the month resets. Nothing is dropped; other work continues."
      : "Developer jobs have used most of the developer budget. At the budget they wait; other work continues. Raise it with secbot limits developer <usd>.";
  }
  return limit.line >= 100
    ? "Hand-offs, routines, and reminders wait until you raise this person's limit (secbot limits set <person> <usd>) or the month resets. Nothing is dropped; chat with the lead continues."
    : "This person's agents have used most of their monthly limit. At the limit, hand-offs, routines, and reminders wait; chat with the lead continues. Raise it with secbot limits set <person> <usd>.";
}

export function createAlerts(
  env: AlertEnv,
  person: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Alerts {
  const base = env.BETTERSTACK_BASE_URL || "https://incidents.betterstack.com";
  /** Creates one incident and logs `model.alert` with `fields`; never throws. */
  async function post(
    summary: string,
    description: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const token = env.BETTERSTACK_INCIDENTS_TOKEN;
    const email = env.BETTERSTACK_REQUESTER_EMAIL;
    if (!token || !email) {
      logEvent("model.alert", { cell: person, ...fields, outcome: "skipped", http_status: null });
      return true;
    }
    try {
      const response = await fetcher(`${base}/api/v3/incidents`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          summary,
          name: summary,
          description,
          requester_email: email,
          push: true,
          email: true,
        }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      const ok = response.ok;
      logEvent(
        "model.alert",
        { cell: person, ...fields, outcome: ok ? "sent" : "failed", http_status: response.status },
        ok ? "info" : "error",
      );
      return ok;
    } catch (error) {
      // A timeout, DNS, TLS, or network fault: the class name tells them apart; never the URL.
      logEvent(
        "model.alert",
        { cell: person, ...fields, outcome: "failed", http_status: null, ...errorFields(error) },
        "error",
      );
      return false;
    }
  }
  return {
    send: (kind) => post(ALERT_SUMMARIES[kind](person), DESCRIPTIONS[kind], { kind }),
    sendLimit: (limit) =>
      post(limitSummary(person, limit), limitDescription(limit), {
        kind: "limit",
        budget: limit.budget,
        line: limit.line,
      }),
  };
}
