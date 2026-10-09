/**
 * How a person cell (and the owner's routes) reach the secrets cell: over the private network at
 * `<SECBOT_SECRETS_URL>/internal/secrets/*` with the operator key when that var is set, otherwise
 * through the `SECRETS_CELL` binding's stub in one fleet. The household client's pattern
 * (household-client.ts): three attempts on a network error or a 5xx, a 4xx final.
 *
 * The secrets cell answers every method with `SecretsAnswer`; this client turns a refusal (4xx)
 * into `SecretsRefused` with the cell's reason and no answer (or 5xx) into `SecretsUnavailable`.
 * It logs `secrets.call { transport, method, outcome, attempts }`, never a value.
 */
import {
  type BrokerAnswer,
  errorFields,
  logEvent,
  type RotateResult,
  type SecretInput,
  type SecretListing,
  type SecretsClient,
  SecretsRefused,
  SecretsUnavailable,
} from "@secbot/cell-harness";
import { SECRETS_CELL_NAME, type SecretsAnswer, type SecretsCell } from "@secbot/secrets-cell";
import { OPERATOR_HEADER } from "./household-client.ts";

const ATTEMPTS = 3;
const RETRY_MS = 250;
/** A broker call waits up to 30 s for its target; the client allows a little more. */
const CALL_TIMEOUT_MS = 40_000;

/** The secrets cell's methods; the HTTP path is the same name. */
export type SecretsMethod =
  | "get"
  | "broker"
  | "list"
  | "grant"
  | "revoke"
  | "add"
  | "allowlist"
  | "rotate"
  | "redaction-values";

/** The secrets cell's RPC surface, as the binding's stub exposes it. */
export type SecretsStubLike = Pick<
  SecretsCell,
  | "get"
  | "broker"
  | "list"
  | "grant"
  | "revoke"
  | "add"
  | "allowlist"
  | "rotate"
  | "redactionValues"
  | "status"
  | "alarmReport"
>;

export interface SecretsNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): SecretsStubLike;
}

export interface SecretsClientEnv {
  readonly SECRETS_CELL?: SecretsNamespaceLike;
  /** The secrets fleet's private address, for example http://<host>:<port>. */
  readonly SECBOT_SECRETS_URL?: string;
  readonly SECBOT_OPERATOR_KEY?: string;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The answer's value, or the refusal or unavailability it carries. */
function answerValue<T>(answer: SecretsAnswer<T>): T {
  if (answer.ok) return answer.value;
  if (answer.status < 500) throw new SecretsRefused(answer.error);
  throw new SecretsUnavailable();
}

/** Every method over one call function (HTTP or the stub). */
function clientOver(call: <T>(method: SecretsMethod, body: unknown) => Promise<T>): SecretsClient {
  return {
    get: (person, agent, name) => call<{ value: string }>("get", { person, agent, name }),
    broker: (person, agent, name, request) =>
      call<BrokerAnswer>("broker", { person, agent, name, request }),
    list: (person) => call<SecretListing[]>("list", { person }),
    grant: (person, secret, agent) =>
      call<{ granted: boolean }>("grant", { person, secret, agent }),
    revoke: (person, secret, agent) =>
      call<{ revoked: boolean }>("revoke", { person, secret, agent }),
    add: (input: SecretInput) => call<{ keyId: string; replaced: boolean }>("add", input),
    allowlist: (person, secret, agent, action) =>
      call<{ changed: boolean; revoked: boolean }>("allowlist", { person, secret, agent, action }),
    rotate: () => call<RotateResult>("rotate", {}),
    redactionValues: async (person) =>
      (await call<{ values: string[] }>("redaction-values", { person })).values,
  };
}

/** A client over HTTP: three attempts on a network error or a 5xx, the same body each time. */
export function httpSecretsClient(
  url: string,
  key: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): SecretsClient {
  const base = url.replace(/\/+$/, "");
  return clientOver(async <T>(method: SecretsMethod, body: unknown): Promise<T> => {
    let lastError: unknown = new SecretsUnavailable();
    let tried = 0;
    // A brokered call is never repeated: the target may have acted on the first attempt.
    const attempts = method === "broker" ? 1 : ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      tried = attempt;
      try {
        const response = await fetcher(`${base}/internal/secrets/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json", [OPERATOR_HEADER]: key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const answer = (await response.json().catch(() => ({}))) as { error?: string } & T;
        if (response.ok) {
          logEvent("secrets.call", { transport: "http", method, outcome: "ok", attempts: attempt });
          return answer;
        }
        lastError =
          response.status < 500
            ? new SecretsRefused(answer.error ?? `secrets ${method} answered ${response.status}`)
            : new SecretsUnavailable();
        // A refusal (4xx) is final; a retry would be refused the same way.
        if (response.status < 500) break;
      } catch (error) {
        lastError = new SecretsUnavailable();
        logEvent("secrets.call_error", { method, attempt, ...errorFields(error) }, "warn");
      }
      if (attempt < attempts) await pause(RETRY_MS * attempt);
    }
    const refused = lastError instanceof SecretsRefused;
    logEvent(
      "secrets.call",
      { transport: "http", method, outcome: refused ? "refused" : "failed", attempts: tried },
      refused ? "warn" : "error",
    );
    throw lastError;
  });
}

/** A client over the binding's stub, so the harness never holds the stub itself. */
export function stubSecretsClient(stub: SecretsStubLike): SecretsClient {
  const methods: Record<SecretsMethod, (body: never) => Promise<SecretsAnswer<unknown>>> = {
    get: (body) => stub.get(body),
    broker: (body) => stub.broker(body),
    list: (body) => stub.list(body),
    grant: (body) => stub.grant(body),
    revoke: (body) => stub.revoke(body),
    add: (body) => stub.add(body),
    allowlist: (body) => stub.allowlist(body),
    rotate: () => stub.rotate({}),
    "redaction-values": (body) => stub.redactionValues(body),
  };
  return clientOver(async <T>(method: SecretsMethod, body: unknown): Promise<T> => {
    let answer: SecretsAnswer<unknown>;
    try {
      answer = await methods[method](body as never);
    } catch (error) {
      logEvent(
        "secrets.call",
        { transport: "rpc", method, outcome: "failed", attempts: 1, ...errorFields(error) },
        "error",
      );
      throw new SecretsUnavailable();
    }
    logEvent(
      "secrets.call",
      { transport: "rpc", method, outcome: answer.ok ? "ok" : "refused", attempts: 1 },
      answer.ok ? "info" : "warn",
    );
    return answerValue(answer) as T;
  });
}

/** The secrets cell's stub in this fleet, or undefined without the binding. */
export const secretsOf = (env: {
  readonly SECRETS_CELL?: SecretsNamespaceLike;
}): SecretsStubLike | undefined =>
  env.SECRETS_CELL?.get(env.SECRETS_CELL.idFromName(SECRETS_CELL_NAME));

/** The secrets client for this cell's environment, or undefined when it has neither path. */
export function secretsClientOf(
  env: SecretsClientEnv,
  fetcher?: typeof fetch,
): SecretsClient | undefined {
  const url = env.SECBOT_SECRETS_URL ?? "";
  if (url !== "") return httpSecretsClient(url, env.SECBOT_OPERATOR_KEY ?? "", fetcher);
  const stub = secretsOf(env);
  return stub === undefined ? undefined : stubSecretsClient(stub);
}
