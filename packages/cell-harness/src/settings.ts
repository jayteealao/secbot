import type { Extension, HarnessSettings } from "@earendil-works/pi-durable";

/**
 * Durable generation retries with no ceiling: 429, 5xx, timeouts, and (through credit-pause.ts)
 * credit errors are retried with exponential backoff capped at one minute, so a request is never
 * dropped and work resumes within a minute of recovery. pi-ai's `retryDelayMs` handles the
 * overflow of `2 ** attempt` (source: pi-ai v1.0.3 src/utils/retry.ts:123-127), and pi-durable
 * retries while `attempt <= maxRetries` (source: pi-durable v1.0.3 src/harness/generation.ts:476-482).
 */
export const RETRY_POLICY = {
  enabled: true,
  maxRetries: Number.MAX_SAFE_INTEGER,
  baseDelayMs: 2_000,
  maxAgentDelayMs: 60_000,
} as const;

/**
 * Harness-wide settings for a person cell. Settings are read at every use and are the same for
 * every conversation (pi-durable v1.0.3 src/harness/types.ts:411-422).
 */
export function cellSettings(defaultExtensions: readonly Extension[]): HarnessSettings {
  return {
    extensions: defaultExtensions,
    // "short" is pi-ai's default too; stated so the lead's Anthropic requests carry cache_control
    // (pi-ai v1.0.3 src/api/anthropic-messages.ts:69-91).
    stream: { timeoutMs: 120_000, cacheRetention: "short" },
    retry: RETRY_POLICY,
    compaction: { enabled: true },
    // Each commit waits for the bucket round trip on a one-node fleet; commit progress less often
    // (pi-durable README "Watching a Conversation").
    progress: { partialIntervalMs: 500, outputIntervalMs: 500 },
  };
}
