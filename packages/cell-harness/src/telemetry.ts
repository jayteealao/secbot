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
import { JobBoardDoc, RosterDoc, TemplatesDoc } from "./docs.ts";
import type { ModelHealthMonitor } from "./model-health.ts";
import { LEAD_ROLE } from "./release-defaults.ts";
import { templatesOf } from "./templates.ts";

/**
 * A conversation's role: the lead, a (frozen) specialist by name, a job by its template's name
 * (so person and owner rules on an agent name, and the developer budget, apply inside its jobs),
 * or "other".
 */
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
  const board = await api.snapshot(JobBoardDoc, context);
  const n = board?.byConversation[String(conversationId)];
  const row = n === undefined ? undefined : board?.jobs[String(n)];
  return row?.template ?? "other";
}

/** The job a conversation belongs to, by number, or null for any other conversation. */
export async function jobOf(
  api: Pick<HookApi, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<number | null> {
  if (conversationId === ROOT_CONVERSATION_ID) return null;
  const board = await api.snapshot(JobBoardDoc, context);
  return board?.byConversation[String(conversationId)] ?? null;
}

/** Every agent name a rule can name: the lead, each specialist, and each job template. */
export async function agentNames(
  api: Pick<HookApi, "snapshot">,
  context: Context,
): Promise<Set<string>> {
  const roster = await api.snapshot(RosterDoc, context);
  const custom = (await api.snapshot(TemplatesDoc, context))?.custom ?? {};
  return new Set([
    LEAD_ROLE,
    ...Object.keys(roster?.specialists ?? {}),
    ...templatesOf(custom).map((template) => template.name),
  ]);
}

export function modelCallLine(
  person: string,
  role: string,
  conversationId: ConversationId,
  message: AssistantMessage,
  /** When the line is written; the duration runs from the message's creation to it. */
  at: number = Date.now(),
  /** The job the conversation belongs to, or null. */
  job: number | null = null,
) {
  return {
    cell: person,
    role,
    job,
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
          const job = await jobOf(api, api.conversationId, context);
          logEvent(
            "model.call",
            modelCallLine(person, role, api.conversationId, message, Date.now(), job),
          );
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
