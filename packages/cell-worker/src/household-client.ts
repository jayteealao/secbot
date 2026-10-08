/**
 * How a person cell reaches the household cell.
 *
 * celld JS RPC works only between objects of one fleet's application, and production runs the
 * owner cell in its own fleet (celld v0.6.1 README, "A fleet runs one application"). So when
 * `SECBOT_HOUSEHOLD_URL` is set, the person cell calls the household cell's `read` and `apply`
 * (and the budget board's `budget`, `report-spend`, `set-budget`, `alert-sent`) over the private
 * network at `<url>/internal/household/*`, with the operator key; otherwise it uses the
 * `HOUSEHOLD_CELL` binding's stub. Both carry the same change with the same operation id, so a
 * retry after a lost answer applies once (the change log's and the board's unique op ids; a
 * setting or an alert outcome is the same write again).
 *
 * Logs `household.call { transport, method, outcome, attempts }`, never the item text.
 */
import type {
  BudgetBoard,
  BudgetSettings,
  HouseholdApplyResult,
  HouseholdChange,
  HouseholdClient,
  HouseholdDocument,
  ReportSpendResult,
} from "@secbot/cell-harness";
import { errorFields, logEvent } from "@secbot/cell-harness";
import { HOUSEHOLD_CELL_NAME, isRefusedHouseholdChange } from "@secbot/household-cell";
import type { HouseholdNamespaceLike, HouseholdStubLike } from "./person-cell.ts";

export const OPERATOR_HEADER = "x-secbot-operator";
const ATTEMPTS = 3;
const RETRY_MS = 250;
const CALL_TIMEOUT_MS = 30_000;

/** The household cell's methods a person cell calls; the HTTP path is the same name. */
export type HouseholdMethod =
  | "read"
  | "apply"
  | "budget"
  | "report-spend"
  | "set-budget"
  | "alert-sent";

export interface HouseholdClientEnv {
  readonly HOUSEHOLD_CELL?: HouseholdNamespaceLike;
  /** The household fleet's private address, for example http://<host>:<port>. */
  readonly SECBOT_HOUSEHOLD_URL?: string;
  readonly SECBOT_OPERATOR_KEY?: string;
}

/** The household cell's answer was not usable; the message is the cell's own error text. */
export class HouseholdCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HouseholdCallError";
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client over HTTP: three attempts on a network error or a 5xx, the same body each time. */
export function httpHouseholdClient(
  url: string,
  key: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): HouseholdClient {
  const base = url.replace(/\/+$/, "");
  const call = async <T>(method: HouseholdMethod, body: unknown): Promise<T> => {
    let lastError: unknown;
    let tried = 0;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      tried = attempt;
      try {
        const response = await fetcher(`${base}/internal/household/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json", [OPERATOR_HEADER]: key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const answer = (await response.json().catch(() => ({}))) as { error?: string } & T;
        if (response.ok) {
          logEvent("household.call", {
            transport: "http",
            method,
            outcome: attempt === 1 ? "ok" : "retried",
            attempts: attempt,
          });
          return answer;
        }
        lastError = new HouseholdCallError(
          answer.error ?? `household ${method} answered ${response.status}`,
          response.status,
        );
        // A refusal (4xx) is final; a retry would be refused the same way.
        if (response.status < 500) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < ATTEMPTS) await pause(RETRY_MS * attempt);
    }
    const refused = lastError instanceof HouseholdCallError && lastError.status < 500;
    logEvent(
      "household.call",
      {
        transport: "http",
        method,
        outcome: refused ? "refused" : "failed",
        attempts: tried,
        status: lastError instanceof HouseholdCallError ? lastError.status : null,
        ...errorFields(lastError),
      },
      refused ? "warn" : "error",
    );
    throw lastError;
  };
  return {
    read: (document) => call<HouseholdDocument>("read", { document }),
    apply: (change) => call<HouseholdApplyResult>("apply", change),
    budget: () => call<BudgetBoard>("budget", {}),
    reportSpend: (report) => call<ReportSpendResult>("report-spend", report),
    setBudget: (change) => call<BudgetSettings>("set-budget", change),
    alertSent: async (outcome) => {
      await call<unknown>("alert-sent", outcome);
    },
  };
}

/** A client over the binding's stub, so the harness never holds the stub itself. */
export function stubHouseholdClient(stub: HouseholdStubLike): HouseholdClient {
  const logged = async <T>(method: HouseholdMethod, work: () => Promise<T>): Promise<T> => {
    try {
      const result = await work();
      logEvent("household.call", { transport: "rpc", method, outcome: "ok", attempts: 1 });
      return result;
    } catch (error) {
      // A refusal (a bad change or setting) is the caller's error, as a 4xx is over HTTP.
      const refused = isRefusedHouseholdChange(error);
      logEvent(
        "household.call",
        {
          transport: "rpc",
          method,
          outcome: refused ? "refused" : "failed",
          attempts: 1,
          ...errorFields(error),
        },
        refused ? "warn" : "error",
      );
      throw error;
    }
  };
  const client: HouseholdClient = {
    read: (document) => logged("read", () => stub.read(document)),
    apply: (change: HouseholdChange) => logged("apply", () => stub.apply(change)),
  };
  // A household cell from before the budget board has none of these; the cell then keeps its
  // own settings and sends its own alerts.
  if (stub.budget !== undefined) {
    client.budget = () => logged("budget", () => stub.budget?.() as Promise<BudgetBoard>);
  }
  if (stub.reportSpend !== undefined) {
    client.reportSpend = (report) =>
      logged("report-spend", () => stub.reportSpend?.(report) as Promise<ReportSpendResult>);
  }
  if (stub.setBudget !== undefined) {
    client.setBudget = (change) =>
      logged("set-budget", () => stub.setBudget?.(change) as Promise<BudgetSettings>);
  }
  if (stub.alertSent !== undefined) {
    client.alertSent = (outcome) =>
      logged("alert-sent", () => stub.alertSent?.(outcome) as Promise<void>);
  }
  return client;
}

/** The household client for this cell's environment, or undefined when it has neither path. */
export function householdClientOf(
  env: HouseholdClientEnv,
  fetcher?: typeof fetch,
): HouseholdClient | undefined {
  const url = env.SECBOT_HOUSEHOLD_URL ?? "";
  if (url !== "") return httpHouseholdClient(url, env.SECBOT_OPERATOR_KEY ?? "", fetcher);
  const namespace = env.HOUSEHOLD_CELL;
  if (namespace === undefined) return undefined;
  return stubHouseholdClient(namespace.get(namespace.idFromName(HOUSEHOLD_CELL_NAME)));
}
