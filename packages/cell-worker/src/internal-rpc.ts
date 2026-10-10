/**
 * One call to another fleet's cell over the private network: POST `<url><path>` with the operator
 * key, a few attempts on a network error or a 5xx with a short pause between them, and a 4xx
 * final (a retry would be refused the same way). The household and secrets clients map their
 * methods and errors over it; neither logs nor sees a value here.
 */

/** The header that carries the operator key between fleets. */
export const OPERATOR_HEADER = "x-secbot-operator";
/** Attempts for a call that is safe to repeat. */
export const INTERNAL_ATTEMPTS = 3;
const RETRY_MS = 250;

export interface InternalCall {
  /** The other fleet's private address, for example http://<host>:<port>. */
  readonly url: string;
  readonly key: string;
  /** For example `/internal/secrets/get`. */
  readonly path: string;
  readonly body: unknown;
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch;
  /** One failed attempt: its HTTP status (null when nothing answered) and the error. */
  readonly onAttemptFailed?: (attempt: number, status: number | null, error: unknown) => void;
}

/** How the call ended; `attempts` and `durationMs` cover every attempt. */
export type InternalOutcome<T> =
  | {
      readonly kind: "ok";
      readonly value: T;
      readonly attempts: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "refused" | "failed";
      /** The last HTTP status, or null when nothing answered. */
      readonly status: number | null;
      /** The answer's `error` text, when it sent one. */
      readonly message: string | undefined;
      /** The last thrown error, when nothing answered. */
      readonly cause: unknown;
      readonly attempts: number;
      readonly durationMs: number;
    };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function postInternal<T>(call: InternalCall): Promise<InternalOutcome<T>> {
  const started = Date.now();
  const base = call.url.replace(/\/+$/, "");
  let status: number | null = null;
  let message: string | undefined;
  let cause: unknown;
  let tried = 0;
  for (let attempt = 1; attempt <= call.attempts; attempt++) {
    tried = attempt;
    try {
      const response = await call.fetcher(`${base}${call.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [OPERATOR_HEADER]: call.key },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(call.timeoutMs),
      });
      const answer = (await response.json().catch(() => ({}))) as { error?: string } & T;
      if (response.ok) {
        return { kind: "ok", value: answer, attempts: attempt, durationMs: Date.now() - started };
      }
      status = response.status;
      message = typeof answer.error === "string" ? answer.error : undefined;
      cause = undefined;
      if (response.status < 500) {
        return {
          kind: "refused",
          status,
          message,
          cause,
          attempts: attempt,
          durationMs: Date.now() - started,
        };
      }
      call.onAttemptFailed?.(attempt, status, undefined);
    } catch (error) {
      status = null;
      message = undefined;
      cause = error;
      call.onAttemptFailed?.(attempt, null, error);
    }
    if (attempt < call.attempts) await pause(RETRY_MS * attempt);
  }
  return {
    kind: "failed",
    status,
    message,
    cause,
    attempts: tried,
    durationMs: Date.now() - started,
  };
}
