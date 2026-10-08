/**
 * Keeps a request when the OpenRouter key runs out of credit.
 *
 * pi-ai classifies quota and billing text as never retryable, and pi-durable then settles the
 * input unanswered (source: pi-ai v1.0.3 src/utils/retry.ts:7-28 and :246-252, pi-durable v1.0.3
 * src/harness/generation.ts:474-500). OpenRouter answers HTTP 402 when the key or account has no
 * credit (https://openrouter.ai/docs/api-reference/errors). A probe of the installed pi-ai through
 * a local stub gave the terminal error text "402 {...Insufficient credits...}" on the Anthropic
 * messages API and "402: {...}" on chat completions; neither matches pi-ai's retryable list.
 *
 * This decorator rewrites only such a terminal error into a retryable one tagged with
 * CREDIT_MARKER, so the durable generation waits at the capped backoff and resumes on its own once
 * the limit rises. Every other event passes through unchanged.
 */
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";

/** Prefix of a rewritten credit error; telemetry and model health read it. */
export const CREDIT_MARKER = "[secbot.credit]";

const CREDIT_ERROR = /^\s*402\b|insufficient.?credits|credit.?limit|key.?limit|insufficient_quota/i;

export const isCreditError = (message: Pick<AssistantMessage, "stopReason" | "errorMessage">) =>
  message.stopReason === "error" &&
  typeof message.errorMessage === "string" &&
  (message.errorMessage.startsWith(CREDIT_MARKER) || CREDIT_ERROR.test(message.errorMessage));

/** The rewritten text names the HTTP status and "retry delay", which pi-ai retries. */
export const CREDIT_PAUSE_TEXT = `${CREDIT_MARKER} credit limit reached (HTTP 402); request kept; retry delay applies`;

export function rewriteCreditError(message: AssistantMessage): AssistantMessage {
  if (!isCreditError(message) || message.errorMessage?.startsWith(CREDIT_MARKER)) return message;
  return { ...message, errorMessage: CREDIT_PAUSE_TEXT };
}

function passThrough(inner: AssistantMessageEventStream): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of inner) {
        if (event.type === "error" && event.reason === "error") {
          outer.push({ ...event, error: rewriteCreditError(event.error) });
        } else {
          outer.push(event);
        }
      }
      outer.end();
    } catch {
      // The inner stream never throws by contract; if it does, its result settles the outer one.
      outer.end(rewriteCreditError(await inner.result()));
    }
  })();
  return outer;
}

/**
 * Wraps a provider: credit errors become retryable, and `baseUrl` (tests only) replaces the
 * OpenRouter origin of every model so requests reach a local stub.
 */
export function withCreditPause<TApi extends string>(
  inner: Provider<TApi>,
  baseUrl?: string,
): Provider<TApi> {
  const target = <M extends Model<TApi>>(model: M): M =>
    baseUrl === undefined
      ? model
      : { ...model, baseUrl: model.baseUrl.replace("https://openrouter.ai", baseUrl) };
  const decorated: Provider<TApi> = {
    id: inner.id,
    name: inner.name,
    auth: inner.auth,
    getModels: () => inner.getModels(),
    stream: (model, context, options) => passThrough(inner.stream(target(model), context, options)),
    streamSimple: (model, context, options) =>
      passThrough(inner.streamSimple(target(model), context, options)),
  };
  return Object.assign(
    decorated,
    inner.baseUrl === undefined ? {} : { baseUrl: inner.baseUrl },
    inner.headers === undefined ? {} : { headers: inner.headers },
    inner.getAllModels === undefined ? {} : { getAllModels: () => inner.getAllModels?.() ?? [] },
    inner.filterModels === undefined ? {} : { filterModels: inner.filterModels.bind(inner) },
    inner.filterAllModels === undefined
      ? {}
      : { filterAllModels: inner.filterAllModels.bind(inner) },
    inner.refreshModels === undefined ? {} : { refreshModels: inner.refreshModels.bind(inner) },
  );
}
