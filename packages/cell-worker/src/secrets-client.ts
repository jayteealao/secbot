/**
 * How a person cell (and the owner's routes) reach the secrets cell: over the private network at
 * `<SECBOT_SECRETS_URL>/internal/secrets/*` with the operator key when that var is set, otherwise
 * through the `SECRETS_CELL` binding's stub in one fleet. Over HTTP (internal-rpc.ts): three
 * attempts on a network error or a 5xx, a 4xx final; a brokered call and a rotation are sent once,
 * because the first attempt may have acted.
 *
 * The secrets cell answers every method with `SecretsAnswer`; this client turns a refusal (4xx)
 * into `SecretsRefused` with the cell's reason and no answer (or 5xx) into `SecretsUnavailable`.
 * It logs `secrets.call { transport, method, person, outcome, attempts, http_status, duration_ms }`
 * and one `secrets.call_error` per failed HTTP attempt, never a value.
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
import { INTERNAL_ATTEMPTS, postInternal } from "./internal-rpc.ts";

/** A broker call waits up to 30 s for its target; the client allows a little more. */
const CALL_TIMEOUT_MS = 40_000;

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

type SecretsCall = (stub: SecretsStubLike, body: never) => Promise<SecretsAnswer<unknown>>;

/**
 * Each method's call on the stub: the one table the binding's client and the worker's
 * `/internal/secrets/*` route both use, so a method is added in one place.
 */
export const SECRETS_CALLS: Readonly<Record<SecretsMethod, SecretsCall>> = {
  get: (stub, body) => stub.get(body),
  broker: (stub, body) => stub.broker(body),
  list: (stub, body) => stub.list(body),
  grant: (stub, body) => stub.grant(body),
  revoke: (stub, body) => stub.revoke(body),
  add: (stub, body) => stub.add(body),
  allowlist: (stub, body) => stub.allowlist(body),
  rotate: (stub) => stub.rotate({}),
  "redaction-values": (stub, body) => stub.redactionValues(body),
};

export const isSecretsMethod = (method: string): method is SecretsMethod =>
  Object.hasOwn(SECRETS_CALLS, method);

/** Calls that are never repeated: the first attempt may have acted. */
const SENT_ONCE: ReadonlySet<SecretsMethod> = new Set(["broker", "rotate"]);

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

/** The answer's value, or the refusal or unavailability it carries. */
function answerValue<T>(answer: SecretsAnswer<T>): T {
  if (answer.ok) return answer.value;
  if (answer.status < 500) throw new SecretsRefused(answer.error);
  throw new SecretsUnavailable();
}

/** A body's text field, for the log (the person, the request id); null when absent. */
const fieldOf = (body: unknown, field: "person" | "requestId"): string | null => {
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === "string" ? value : null;
};

/** Every method over one call function (HTTP or the stub). */
function clientOver(call: <T>(method: SecretsMethod, body: unknown) => Promise<T>): SecretsClient {
  return {
    get: (person, agent, name, requestId) =>
      call<{ value: string }>("get", { person, agent, name, requestId }),
    broker: (person, agent, name, request, requestId) =>
      call<BrokerAnswer>("broker", { person, agent, name, request, requestId }),
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

/** A client over HTTP: up to three attempts on a network error or a 5xx, the same body each time. */
export function httpSecretsClient(
  url: string,
  key: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): SecretsClient {
  return clientOver(async <T>(method: SecretsMethod, body: unknown): Promise<T> => {
    const person = fieldOf(body, "person");
    const requestId = fieldOf(body, "requestId");
    const outcome = await postInternal<T>({
      url,
      key,
      path: `/internal/secrets/${method}`,
      body,
      attempts: SENT_ONCE.has(method) ? 1 : INTERNAL_ATTEMPTS,
      timeoutMs: CALL_TIMEOUT_MS,
      fetcher,
      onAttemptFailed: (attempt, status, error) =>
        logEvent(
          "secrets.call_error",
          {
            method,
            person,
            request_id: requestId,
            attempt,
            http_status: status,
            ...errorFields(error),
          },
          "warn",
        ),
    });
    const fields = {
      transport: "http",
      method,
      person,
      request_id: requestId,
      attempts: outcome.attempts,
      duration_ms: outcome.durationMs,
    };
    if (outcome.kind === "ok") {
      logEvent("secrets.call", { ...fields, outcome: "ok", http_status: 200 });
      return outcome.value;
    }
    const refused = outcome.kind === "refused";
    logEvent(
      "secrets.call",
      { ...fields, outcome: refused ? "refused" : "failed", http_status: outcome.status },
      refused ? "warn" : "error",
    );
    throw refused
      ? new SecretsRefused(outcome.message ?? `secrets ${method} answered ${outcome.status}`)
      : new SecretsUnavailable();
  });
}

/** A client over the binding's stub, so the harness never holds the stub itself. */
export function stubSecretsClient(stub: SecretsStubLike): SecretsClient {
  return clientOver(async <T>(method: SecretsMethod, body: unknown): Promise<T> => {
    const person = fieldOf(body, "person");
    const requestId = fieldOf(body, "requestId");
    const started = Date.now();
    let answer: SecretsAnswer<unknown>;
    try {
      answer = await SECRETS_CALLS[method](stub, body as never);
    } catch (error) {
      logEvent(
        "secrets.call",
        {
          transport: "rpc",
          method,
          person,
          request_id: requestId,
          outcome: "failed",
          attempts: 1,
          duration_ms: Date.now() - started,
          ...errorFields(error),
        },
        "error",
      );
      throw new SecretsUnavailable();
    }
    logEvent(
      "secrets.call",
      {
        transport: "rpc",
        method,
        person,
        request_id: requestId,
        outcome: answer.ok ? "ok" : answer.status < 500 ? "refused" : "failed",
        attempts: 1,
        duration_ms: Date.now() - started,
      },
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
