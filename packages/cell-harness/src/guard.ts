/**
 * The guard: one `beforeTool` hook on every role (the first extension of the lead's list, the
 * specialists' list, and the harness default), in front of every tool call. It runs an ordered
 * list of stages; the first stage that refuses or holds decides. This release has one stage, the
 * rule stage; later stages (approvals, the decision model, the reviewer) join the same list in
 * the guard's fixed precedence, after the rules, so no model can loosen a rule.
 *
 * The record exists before the call runs: after the stages decide, the guard commits one activity
 * record, logs one `guard.verdict` event, and then lets the call run or blocks it. Hooks run with
 * no transaction open, before the call's intent commit, and a block settles the call with
 * `Tool call blocked: <reason>` without running it (installed pi-durable 1.0.3,
 * node_modules/.pnpm/@earendil-works+pi-durable@_39a2d184757a80d838824f8a34b421a0/node_modules/
 * @earendil-works/pi-durable/dist/harness/tool.js:35-54). A hook waiting at a crash runs again
 * from the start with the same task and call ids (the crash test in test/crash.test.ts), so the
 * record is keyed by both and a rerun writes none.
 *
 * Fail closed: any error inside the guard blocks the call with "the guard failed; the call was not
 * run" and logs `guard.error`.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  type Extension,
  type Harness,
  type HookApi,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { type ActivityRecord, appendRecord, recordOf } from "./activity.ts";
import { errorFields, logEvent } from "./cell-parts.ts";
import { RulesDoc } from "./docs.ts";
import { redactText } from "./redact.ts";
import { decide, ruleText } from "./rules.ts";
import { roleOf } from "./telemetry.ts";

/** One tool call as every stage sees it. */
export interface GuardCall {
  readonly person: string;
  readonly role: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly taskId: string;
  readonly callId: string;
}

/** Where a verdict came from; later stages add their layers. */
export type GuardLayer = ActivityRecord["layer"];

/** A stage's answer. `matched` names the argument fields a rule matched (kept whole in records). */
export type StageResult =
  | {
      readonly kind: "pass";
      readonly layer: GuardLayer;
      readonly reason: string;
      readonly ruleId?: number;
      readonly ruleLevel?: "owner" | "person";
      readonly matched?: readonly string[];
    }
  | {
      readonly kind: "refuse" | "hold";
      readonly layer: GuardLayer;
      readonly reason: string;
      readonly ruleId?: number;
      readonly ruleLevel?: "owner" | "person";
      readonly matched?: readonly string[];
    };

/** One step of the guard. A stage reads committed documents only (the hook has no transaction). */
export type GuardStage = (
  call: GuardCall,
  api: Pick<HookApi, "snapshot">,
  context: Context,
) => Promise<StageResult>;

export const GUARD_FAILED = "the guard failed; the call was not run";

/** Appended to a held call's reason while held calls cannot be answered yet. */
export const HOLD_UNAVAILABLE =
  "this call needs your approval, and approvals are not available in this version yet";

/** The rule stage: deterministic, always first. */
export const ruleStage: GuardStage = async (call, api, context) => {
  const rules = await api.snapshot(RulesDoc, context);
  const decision = decide(rules?.owner ?? [], rules?.person ?? [], call);
  const { rule, level } = decision;
  if (rule === undefined || level === undefined) {
    return { kind: "pass", layer: "rule", reason: "no rule matched" };
  }
  const base = {
    layer: "rule" as const,
    reason: `${level === "owner" ? "owner" : "your"} rule: ${ruleText(rule)}`,
    ruleId: rule.id,
    ruleLevel: level,
    matched: decision.matched,
  };
  if (rule.verdict === "prohibit") return { kind: "refuse", ...base };
  if (rule.verdict === "ask-first") return { kind: "hold", ...base };
  return { kind: "pass", ...base };
};

export interface GuardOptions {
  readonly now: () => number;
  readonly timeZone: string;
  /** The stages in precedence order; the rule stage alone by default. */
  readonly stages?: readonly GuardStage[];
}

/** Runs the stages: the first refuse or hold decides; otherwise the last pass explains. */
export async function runStages(
  stages: readonly GuardStage[],
  call: GuardCall,
  api: Pick<HookApi, "snapshot">,
  context: Context,
): Promise<StageResult> {
  let result: StageResult = { kind: "pass", layer: "rule", reason: "no rule matched" };
  for (const stage of stages) {
    const answer = await stage(call, api, context);
    if (answer.kind !== "pass") return answer;
    // A later stage's pass explains only when it decided something; the rule's reason stays.
    if (result.reason === "no rule matched" || answer.ruleId !== undefined) result = answer;
  }
  return result;
}

/** The `secbot-guard` extension for one person's cell. `harness()` returns the open harness. */
export function createGuardExtension(
  person: string,
  harness: () => Harness,
  options: GuardOptions,
): Extension {
  const stages = options.stages ?? [ruleStage];
  return defineExtension({
    name: "secbot-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (toolCall, api, context) => {
          const started = Date.now();
          let role = "other";
          const ids = { task_id: String(api.taskId), call_id: toolCall.id };
          try {
            role = await roleOf(api, api.conversationId, context);
            const call: GuardCall = {
              person,
              role,
              tool: toolCall.name,
              arguments: toolCall.arguments as Record<string, JsonValue>,
              taskId: ids.task_id,
              callId: ids.call_id,
            };
            const result = await runStages(stages, call, api, context);
            const reason =
              result.kind === "hold" ? `${result.reason}; ${HOLD_UNAVAILABLE}` : result.reason;
            const verdict = result.kind === "pass" ? "allowed" : "refused";
            await harness().commit(
              (tx) =>
                appendRecord(
                  tx,
                  recordOf({
                    key: `${ids.task_id}:${ids.call_id}`,
                    at: options.now(),
                    kind: "verdict",
                    agent: role,
                    tool: call.tool,
                    verdict,
                    layer: result.layer,
                    reason,
                    ruleId: result.ruleId ?? null,
                    ruleLevel: result.ruleLevel ?? null,
                    arguments: call.arguments,
                    keep: result.matched ?? [],
                    cost: 0,
                  }),
                  options.timeZone,
                ),
              context,
            );
            logEvent("guard.verdict", {
              cell: person,
              role,
              tool: call.tool,
              verdict,
              layer: result.layer,
              rule_id: result.ruleId ?? null,
              reason: redactText(reason),
              ...ids,
              duration_ms: Date.now() - started,
            });
            return verdict === "allowed" ? undefined : { block: reason };
          } catch (error) {
            logEvent(
              "guard.error",
              { cell: person, role, tool: toolCall.name, ...ids, ...errorFields(error) },
              "error",
            );
            await harness()
              .commit(
                (tx) =>
                  appendRecord(
                    tx,
                    recordOf({
                      key: `${ids.task_id}:${ids.call_id}`,
                      at: options.now(),
                      kind: "verdict",
                      agent: role,
                      tool: toolCall.name,
                      verdict: "refused",
                      layer: "guard",
                      reason: GUARD_FAILED,
                      ruleId: null,
                      ruleLevel: null,
                      arguments: (toolCall.arguments ?? {}) as Record<string, JsonValue>,
                      keep: [],
                      cost: 0,
                    }),
                    options.timeZone,
                  ),
                context,
              )
              .catch(() => {});
            return { block: GUARD_FAILED };
          }
        },
      }),
    ],
  });
}
