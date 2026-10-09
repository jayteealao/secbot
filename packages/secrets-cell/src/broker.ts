/**
 * The broker: for a health or production secret, the secrets cell makes the call with the token
 * and returns only the answer, with the token (and any token-shaped text) redacted, so the agent
 * never holds the token. The target's address is data the owner stored with the secret.
 */
import { type BrokerAnswer, type BrokerRequest, redactText } from "@secbot/cell-harness";

/** A broker target, stored with its secret. */
export interface BrokerTarget {
  readonly kind: "health" | "production";
  /** The service's base address (https, or http on loopback for the stand-in tests). */
  readonly url: string;
  /** The request header that carries the stored value, for example `authorization`. */
  readonly header: string;
}

export const BROKER_TIMEOUT_MS = 30_000;
/** The largest answer body an agent gets, in UTF-16 code units (about 64 KiB of text). */
export const BROKER_BODY_LIMIT = 64 * 1024;
const BROKER_REQUEST_LIMIT = 64 * 1024;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** A request the broker refuses before it calls; the message is the reason a person reads. */
export class BrokerRequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerRequestRefused";
  }
}

/** A stored target's check: an http(s) address with no credentials, query, or fragment, and a header name. */
export function checkTarget(target: unknown): BrokerTarget {
  const value = target as Partial<BrokerTarget> | null;
  if (value === null || typeof value !== "object")
    throw new BrokerRequestRefused("no broker target");
  if (value.kind !== "health" && value.kind !== "production") {
    throw new BrokerRequestRefused("a broker target is health or production");
  }
  if (typeof value.header !== "string" || !HEADER.test(value.header)) {
    throw new BrokerRequestRefused("a broker target needs a header name");
  }
  let url: URL;
  try {
    url = new URL(String(value.url));
  } catch {
    throw new BrokerRequestRefused("a broker target needs an http or https address");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BrokerRequestRefused("a broker target needs an http or https address");
  }
  return {
    kind: value.kind,
    url: url.href.replace(/\/+$/, ""),
    header: value.header.toLowerCase(),
  };
}

/** The request's check: a known method and a path under the target, never another host. */
export function checkRequest(request: BrokerRequest): BrokerRequest {
  if (!METHODS.has(request.method)) throw new BrokerRequestRefused("the method is not allowed");
  if (
    typeof request.path !== "string" ||
    !request.path.startsWith("/") ||
    request.path.startsWith("//") ||
    request.path.includes("\\") ||
    request.path.length > 2_048 ||
    /[\s#]/.test(request.path) ||
    request.path.split(/[/?]/).includes("..")
  ) {
    throw new BrokerRequestRefused(
      "the path must start with / and stay under the service's address",
    );
  }
  if (
    request.body !== undefined &&
    (typeof request.body !== "string" || request.body.length > BROKER_REQUEST_LIMIT)
  ) {
    throw new BrokerRequestRefused("the body is too large");
  }
  return request;
}

/** The token and its forms a target might echo (with or without a `Bearer ` scheme). */
export function tokenForms(token: string): string[] {
  const bare = token.replace(/^bearer\s+/i, "");
  return bare === token ? [token] : [token, bare];
}

/**
 * Calls `target` with `token` in its header. Redirects are not followed (a redirect must not carry
 * the token to another address); the answer body is redacted and capped. A target that does not
 * answer gives status 0 with the cause.
 */
export async function brokerCall(
  target: BrokerTarget,
  token: string,
  request: BrokerRequest,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<BrokerAnswer> {
  const checked = checkRequest(request);
  const values = tokenForms(token);
  let response: Response;
  try {
    response = await fetcher(`${target.url}${checked.path}`, {
      method: checked.method,
      headers: {
        [target.header]: token,
        ...(checked.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(checked.body === undefined ? {} : { body: checked.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      status: 0,
      body: timedOut ? "The service did not answer in time." : "The service did not answer.",
    };
  }
  // Redacted before the cut, so a token that crosses the cut is never left half shown.
  const text = redactText(await response.text().catch(() => ""), values);
  const body =
    text.length > BROKER_BODY_LIMIT ? `${text.slice(0, BROKER_BODY_LIMIT)}\n[cut at 64 KiB]` : text;
  return { status: response.status, body };
}
