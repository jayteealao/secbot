/**
 * One `model.call` log line per terminal provider message, and model health reports.
 * `afterResponse` runs on every terminal provider message, before the generation classifies it
 * (pi-durable v1.0.3 src/harness/types.ts:623 and src/harness/generation.ts:450), so failed
 * attempts that are retried are logged too (stop_reason "error").
 */

import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  GenerationTask,
  type HookApi,
  hook,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { logEvent, safeErrorText } from "./cell-parts.ts";
import { isCreditError } from "./credit-pause.ts";
import { RosterDoc } from "./docs.ts";
import type { ModelHealthMonitor } from "./model-health.ts";
import { LEAD_ROLE } from "./release-defaults.ts";

export async function roleOf(
  api: Pick<HookApi, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<string> {
  if (conversationId === ROOT_CONVERSATION_ID) return LEAD_ROLE;
  const roster = await api.snapshot(RosterDoc, context);
  for (const [name, record] of Object.entries(roster?.specialists ?? {})) {
    if (record.conversationId === conversationId) return name;
  }
  return "other";
}

export function modelCallLine(
  person: string,
  role: string,
  conversationId: ConversationId,
  message: AssistantMessage,
  /** When the line is written; the duration runs from the message's creation to it. */
  at: number = Date.now(),
) {
  return {
    cell: person,
    role,
    conversation_id: conversationId,
    provider: message.provider,
    model: message.model,
    served_model: message.responseModel ?? message.model,
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    cache_read_tokens: message.usage.cacheRead,
    cache_write_tokens: message.usage.cacheWrite,
    cost_usd: message.usage.cost.total,
    stop_reason: message.stopReason,
    // A failed attempt's cause as a status and provider code only, never the provider's text.
    error_code:
      message.stopReason === "error"
        ? safeErrorText(message.errorMessage ?? "unknown error")
        : null,
    duration_ms: Math.max(0, at - message.timestamp),
    credit: isCreditError(message),
  };
}

export function createTelemetryExtension(person: string, monitor: ModelHealthMonitor): Extension {
  return defineExtension({
    name: "secbot-telemetry",
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message, api, context) => {
          const role = await roleOf(api, api.conversationId, context);
          logEvent("model.call", modelCallLine(person, role, api.conversationId, message));
          if (message.stopReason === "error") {
            monitor.report({
              kind: "failure",
              error: message.errorMessage ?? "unknown error",
              credit: isCreditError(message),
            });
          } else if (message.stopReason !== "aborted") {
            monitor.report({ kind: "success" });
          }
        },
      }),
    ],
  });
}
