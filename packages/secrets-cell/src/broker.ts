/**
 * The broker: for a health or production secret, the secrets cell makes the call with the token
 * and returns only the answer, with the token (and any token-shaped text) redacted, so the agent
 * never holds the token. The target's address is data the owner stored with the secret.
 */
import { type BrokerAnswer, type BrokerRequest, redactTokens } from "@secbot/cell-harness";

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

/** A dot segment, also when its dots are percent-encoded (`%2e%2e`, `.%2E`). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
/** An encoded slash or backslash, which a target might decode into another path. */
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

/** The request's check: a known method and a path under the target, never another host. */
export function checkRequest(request: BrokerRequest): BrokerRequest {
  if (!METHODS.has(request.method)) throw new BrokerRequestRefused("the method is not allowed");
  const path = typeof request.path === "string" ? request.path : "";
  const pathPart = path.split("?")[0] ?? "";
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.length > 2_048 ||
    /[\s#]/.test(path) ||
    pathPart.split("/").some((segment) => DOT_SEGMENT.test(segment)) ||
    ENCODED_SEPARATOR.test(pathPart)
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

/**
 * The address a request goes to. The URL parser resolves what the checks above let through; the
 * result must still have the target's origin and sit under the target's path, or it is refused.
 */
export function requestUrl(target: BrokerTarget, path: string): URL {
  const base = new URL(target.url);
  const url = new URL(`${target.url}${path}`);
  const root = base.pathname.replace(/\/+$/, "");
  if (
    url.origin !== base.origin ||
    (url.pathname !== root && !url.pathname.startsWith(`${root}/`))
  ) {
    throw new BrokerRequestRefused(
      "the path must start with / and stay under the service's address",
    );
  }
  return url;
}

/** The token and its forms a target might echo (with or without a `Bearer ` scheme). */
export function tokenForms(token: string): string[] {
  const bare = token.replace(/^bearer\s+/i, "");
  return bare === token ? [token] : [token, bare];
}

/** How a broker call went, for the secrets cell's log; never the token, the path, or the body. */
export interface BrokerTiming {
  /** Why the target gave no answer: it timed out, or the connection failed. */
  readonly cause: "timeout" | "network" | null;
  readonly durationMs: number;
}

/** Reads at most twice the body limit, so a large answer is never held whole. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/**
 * Calls `target` with `token` in its header. Redirects are not followed (a redirect must not carry
 * the token to another address); the answer body is read up to twice its cap, redacted, and cut.
 * A target that does not answer gives status 0 with the cause. `observe` gets the timing.
 */
export async function brokerCall(
  target: BrokerTarget,
  token: string,
  request: BrokerRequest,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  observe: (timing: BrokerTiming) => void = () => {},
): Promise<BrokerAnswer> {
  const checked = checkRequest(request);
  const url = requestUrl(target, checked.path);
  const values = tokenForms(token);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(url.href, {
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
    observe({ cause: timedOut ? "timeout" : "network", durationMs: Date.now() - started });
    return {
      status: 0,
      body: timedOut ? "The service did not answer in time." : "The service did not answer.",
    };
  }
  const raw = await readCapped(response, 2 * BROKER_BODY_LIMIT).catch(() => "");
  observe({ cause: null, durationMs: Date.now() - started });
  // Only the token's forms are replaced: the answer is the service's data, and ids or long names
  // in it must reach the agent whole. Redacted before the cut, so a token that crosses the cut is
  // never left half shown.
  const text = redactTokens(raw, values);
  const body =
    text.length > BROKER_BODY_LIMIT ? `${text.slice(0, BROKER_BODY_LIMIT)}\n[cut at 64 KiB]` : text;
  return { status: response.status, body };
}
