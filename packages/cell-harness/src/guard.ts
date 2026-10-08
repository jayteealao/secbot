/**
 * The guard: one `beforeTool` hook on every role (the first extension of the lead's list, the
 * specialists' list, and the harness default), in front of every tool call. It runs an ordered
 * list of stages; the first stage that refuses or holds decides. This release has one stage, the
 * rule stage; later stages (the decision model, the reviewer) join the same list in the guard's
 * fixed precedence, after the rules, so no model can loosen a rule.
 *
 * The record exists before the call runs: after the stages decide, the guard commits one activity
 * record, logs one `guard.verdict` event, and then lets the call run or blocks it. Hooks run with
 * no transaction open, before the call's intent commit, and a block settles the call with
 * `Tool call blocked: <reason>` without running it (installed pi-durable 1.0.3,
 * node_modules/.pnpm/@earendil-works+pi-durable@_39a2d184757a80d838824f8a34b421a0/node_modules/
 * @earendil-works/pi-durable/dist/harness/tool.js:35-54). No other hook runs after the guard's, so
 * the arguments it checks are the arguments that run.
 *
 * A hold waits for the person (approvals.ts): the held-call record is committed before the wait,
 * and the hook's first act is a lookup by request id, because a hook waiting at a crash runs again
 * from the start with the same task and call ids (the crash test in test/crash.test.ts). An answer
 * never clears a prohibit: when a held call is allowed, the rule stage runs again before it runs.
 *
 * Fail closed: any error inside the guard blocks the call with "the guard failed; the call was not
 * run" and logs `guard.error`. An abort (the job was aborted, or the harness is closing) is passed
 * on, so pi-durable's abort path settles the call; an aborted job lapses its held call first.
 *
 * The model stage (createModelStage) runs after the rules, only on a call they passed: the
 * decision model passes it or marks it, and a mark or any decision-model failure goes to the
 * reviewer, which allows, blocks, or asks the person; a reviewer failure holds the call. In shadow
 * mode (every cell's start) the model stage records what it would do and lets the call run; the
 * rule stage and the hold path never read the mode, so rules and ask-first holds always enforce.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type Harness,
  type HookApi,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  type ActivityRecord,
  appendRecord,
  type DecisionRecord,
  type GuardModelFields,
  modelRecordFields,
  recordOf,
} from "./activity.ts";
import {
  type AlwaysOffer,
  alwaysOffer,
  argumentDigest,
  consumeHeld,
  defaultSetTimer,
  findHeld,
  type HeldCall,
  heldEvent,
  holdCall,
  LAPSED_TEXT,
  lapseHeld,
  type ReasonSource,
  readHeld,
  type SetTimer,
  USED_TEXT,
  waitForAnswer,
} from "./approvals.ts";
import { errorFields, logEvent } from "./cell-parts.ts";
import { buildDecisionState, DecisionFailure, type DecisionModels } from "./decision-model.ts";
import { RosterDoc, RulesDoc } from "./docs.ts";
import { readDecisionAdapter, readGuardMode } from "./guard-settings.ts";
import { redactText } from "./redact.ts";
import { HOLD_MS, LEAD_ROLE } from "./release-defaults.ts";
import { type Reviewer, ReviewerFailure, type ReviewVerdict } from "./reviewer.ts";
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

/**
 * A stage's answer. `matched` names the argument fields a rule matched (kept whole in records);
 * `model` carries the model stage's mode, decision, fallback, and cost into the record.
 */
export type StageResult =
  | {
      readonly kind: "pass";
      readonly layer: GuardLayer;
      readonly reason: string;
      readonly ruleId?: number;
      readonly ruleLevel?: "owner" | "person";
      readonly matched?: readonly string[];
      readonly model?: GuardModelFields;
    }
  | {
      readonly kind: "refuse" | "hold";
      readonly layer: GuardLayer;
      readonly reason: string;
      readonly ruleId?: number;
      readonly ruleLevel?: "owner" | "person";
      readonly matched?: readonly string[];
      /** Who held the call; from the rule level when absent. */
      readonly reasonSource?: ReasonSource;
      readonly model?: GuardModelFields;
    };

/** One step of the guard. A stage reads committed documents only (the hook has no transaction). */
export type GuardStage = (
  call: GuardCall,
  api: Pick<HookApi, "snapshot">,
  context: Context,
) => Promise<StageResult>;

export const GUARD_FAILED = "the guard failed; the call was not run";

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
  /**
   * The request id a held call is bound to. Default `<conversation id>:<tool call id>`: one model
   * tool call, the same across a crash rerun. Later inputs (a mail or push id) replace it.
   */
  readonly requestIdOf?: (call: GuardCall, api: Pick<HookApi, "conversationId">) => string;
  /** How long a held call waits; HOLD_MS (24 h) by default. */
  readonly holdMs?: number;
  /** Tests: a controlled timer for the lapse. */
  readonly setTimer?: SetTimer;
}

/**
 * Runs the stages: the first refuse or hold decides; otherwise the last pass explains. A later
 * stage's pass explains only when it decided something (a rule, or the reviewer's review); a
 * permit rule's reason stays over the decision model's pass, which still adds its fields.
 */
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
    if (
      result.reason === "no rule matched" ||
      answer.ruleId !== undefined ||
      answer.layer === "reviewer"
    ) {
      result = answer;
    } else if (answer.model !== undefined) {
      result = { ...result, model: answer.model };
    }
  }
  return result;
}

export interface ModelStageOptions {
  /** The decision model for the cell's current adapter. */
  readonly decision: DecisionModels;
  readonly reviewer: Reviewer;
}

export const REVIEWER_UNAVAILABLE = "reviewer unavailable";

/**
 * The model stage: after the rules, on a call they passed. The decision model can only pass or
 * mark; a mark or a decision-model failure goes to the reviewer. In enforce mode the reviewer's
 * allow runs the call, its block refuses it, and its ask (or its failure) holds it for the person.
 * In shadow mode every outcome runs the call and the record says what would have happened.
 */
export function createModelStage(options: ModelStageOptions): GuardStage {
  return async (call, api, context) => {
    const { mode } = await readGuardMode(api, context);
    const adapter = await readDecisionAdapter(api, context);
    const rules = await api.snapshot(RulesDoc, context);
    const decided = decide(rules?.owner ?? [], rules?.person ?? [], call);
    const rule =
      decided.rule === undefined
        ? "none"
        : `${decided.level === "owner" ? "owner" : "your"} rule: ${ruleText(decided.rule)}`;
    const matched = decided.matched ?? [];
    const state = buildDecisionState(call, rule, matched);
    let costUsd = 0;
    let decision: DecisionRecord;
    let fallback: string | null = null;
    let asked: string;
    try {
      const answer = await options.decision(adapter).ask(state, call.tool, context.abortSignal);
      costUsd += answer.costUsd;
      decision = { outcome: answer.outcome, score: answer.score, model: answer.model };
      const label = `${answer.choice} (score ${answer.score.toFixed(2)})`;
      if (answer.outcome === "pass") {
        return {
          kind: "pass",
          layer: "decision",
          reason: `decision model: ${label}`,
          matched,
          model: { mode, decision, fallback, costUsd },
        };
      }
      asked = label;
    } catch (error) {
      if (!(error instanceof DecisionFailure) || context.abortSignal?.aborted === true) throw error;
      costUsd += error.costUsd;
      fallback = error.cause;
      decision = { outcome: "fallback", score: null, model: null };
      logEvent(
        "guard.fallback",
        {
          cell: call.person,
          role: call.role,
          tool: call.tool,
          adapter,
          cause: error.cause,
          duration_ms: error.durationMs,
        },
        "warn",
      );
      asked = `no answer (${error.cause})`;
    }
    const fields = (verdictWord?: "would block" | "would ask"): GuardModelFields => ({
      mode,
      decision,
      fallback,
      costUsd,
      ...(verdictWord === undefined ? {} : { verdictWord }),
    });
    let review: ReviewVerdict;
    try {
      review = await options.reviewer.review({ state, decision: asked }, context);
    } catch (error) {
      if (!(error instanceof ReviewerFailure) || context.abortSignal?.aborted === true) throw error;
      costUsd += error.costUsd;
      if (mode === "shadow") {
        return {
          kind: "pass",
          layer: "reviewer",
          reason: `shadow: ${REVIEWER_UNAVAILABLE}; the call ran`,
          matched,
          model: fields("would ask"),
        };
      }
      return {
        kind: "hold",
        layer: "reviewer",
        reason: REVIEWER_UNAVAILABLE,
        reasonSource: "reviewer-unavailable",
        matched,
        model: fields(),
      };
    }
    costUsd += review.costUsd;
    if (mode === "shadow") {
      const word =
        review.verdict === "block"
          ? "would block"
          : review.verdict === "ask"
            ? "would ask"
            : undefined;
      return {
        kind: "pass",
        layer: "reviewer",
        reason: `shadow: ${review.reason}; the call ran`,
        matched,
        model: fields(word),
      };
    }
    const reason = `reviewer: ${review.reason}`;
    if (review.verdict === "allow") {
      return { kind: "pass", layer: "reviewer", reason, matched, model: fields() };
    }
    if (review.verdict === "block") {
      return { kind: "refuse", layer: "reviewer", reason, matched, model: fields() };
    }
    return {
      kind: "hold",
      layer: "reviewer",
      reason,
      reasonSource: "reviewer",
      matched,
      model: fields(),
    };
  };
}

type Block = { block: string } | undefined;

/** The `secbot-guard` extension for one person's cell. `harness()` returns the open harness. */
export function createGuardExtension(
  person: string,
  harness: () => Harness,
  options: GuardOptions,
): Extension {
  const stages = options.stages ?? [ruleStage];
  const holdMs = options.holdMs ?? HOLD_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const parts = () => ({ harness: harness(), person, timeZone: options.timeZone });

  /**
   * Commits one verdict record (skipped on a rerun of the same key) and logs `guard.verdict`. The
   * call runs when `fields.verdict` is "allowed"; a shadow "would block" or "would ask" still runs.
   */
  async function verdict(
    call: GuardCall,
    key: string,
    fields: {
      readonly verdict: "allowed" | "refused";
      readonly layer: GuardLayer;
      readonly reason: string;
      readonly ruleId: number | null;
      readonly ruleLevel: "owner" | "person" | null;
      readonly matched: readonly string[];
      readonly model?: GuardModelFields;
      readonly ruleMs?: number | null;
    },
    started: number,
    context: Context,
  ): Promise<Block> {
    const { model } = fields;
    const mode = model?.mode ?? (await readGuardMode(harness(), context)).mode;
    const word = model?.verdictWord ?? fields.verdict;
    await harness().commit(
      (tx) =>
        appendRecord(
          tx,
          recordOf({
            key,
            at: options.now(),
            kind: "verdict",
            agent: call.role,
            tool: call.tool,
            verdict: word,
            layer: fields.layer,
            reason: fields.reason,
            ruleId: fields.ruleId,
            ruleLevel: fields.ruleLevel,
            arguments: call.arguments,
            keep: fields.matched,
            cost: 0,
            mode,
            ...modelRecordFields(model),
          }),
          options.timeZone,
        ),
      context,
    );
    const outcome = model?.decision.outcome ?? null;
    logEvent("guard.verdict", {
      cell: person,
      role: call.role,
      tool: call.tool,
      verdict: word,
      layer: fields.layer,
      rule_id: fields.ruleId,
      reason: redactText(fields.reason),
      task_id: call.taskId,
      call_id: call.callId,
      mode,
      // In shadow mode a mark is what the decision model would have sent to the reviewer.
      decision: outcome === "mark" && mode === "shadow" ? "would mark" : outcome,
      decision_score: model?.decision.score ?? null,
      decision_model: model?.decision.model ?? null,
      fallback: model?.fallback ?? null,
      cost_usd: model?.costUsd ?? 0,
      rule_ms: fields.ruleMs ?? null,
      duration_ms: Date.now() - started,
    });
    return fields.verdict === "allowed" ? undefined : { block: fields.reason };
  }

  /** The allow-always offer for a call the rule stage holds. */
  async function offerFor(
    call: GuardCall,
    matched: readonly string[],
    api: Pick<HookApi, "snapshot">,
    context: Context,
  ): Promise<AlwaysOffer> {
    const rules = await api.snapshot(RulesDoc, context);
    const roster = await api.snapshot(RosterDoc, context);
    const agents = new Set([LEAD_ROLE, ...Object.keys(roster?.specialists ?? {})]);
    return alwaysOffer(
      { owner: rules?.owner ?? [], person: rules?.person ?? [] },
      call,
      matched,
      agents,
    );
  }

  /** Lapses the held call when the abort came from an aborted job (not from the harness closing). */
  async function lapseIfJobAborted(held: HeldCall, call: GuardCall, context: Context) {
    const quiet = withoutAbortSignal(context);
    try {
      const { tasks } = await harness().inspect(quiet);
      const task = tasks.find(({ record }) => String(record.id) === call.taskId)?.record;
      if (task?.abortRequested === true) {
        await lapseHeld(parts(), held.number, "aborted", options.now(), quiet);
      }
    } catch {
      // The harness is closing: the record stays pending, and the rerun after the reopen waits again.
    }
  }

  /**
   * Waits for (or applies) the answer to a held call, then runs it once, refuses it, or lapses it.
   * `held` may come from this call's own hold, a rerun after a crash, or an earlier call under the
   * same request id and the same arguments.
   */
  async function settleHeld(
    first: HeldCall,
    call: GuardCall,
    callKey: string,
    api: Pick<HookApi, "snapshot">,
    started: number,
    context: Context,
  ): Promise<Block> {
    const sameCall = first.callKey === callKey;
    let held = first;
    while (held.status === "pending") {
      if (options.now() >= held.expiresAt) {
        await lapseHeld(parts(), held.number, "expired", options.now(), context);
      } else {
        try {
          await waitForAnswer(
            harness(),
            held.number,
            held.expiresAt - options.now(),
            setTimer,
            context,
          );
        } catch (error) {
          if (context.abortSignal?.aborted === true) await lapseIfJobAborted(held, call, context);
          throw error;
        }
      }
      held = (await readHeld(harness(), held.number, context)) ?? held;
    }
    const outcome = (fields: {
      readonly verdict: "allowed" | "refused";
      readonly layer: GuardLayer;
      readonly reason: string;
    }): Promise<Block> | Block => {
      // This call's own answer or lapse is already its record; a later call under the same
      // request id gets a verdict record of its own.
      if (sameCall) return fields.verdict === "allowed" ? undefined : { block: fields.reason };
      return verdict(
        call,
        callKey,
        { ...fields, ruleId: held.ruleId, ruleLevel: held.ruleLevel, matched: held.matched },
        started,
        context,
      );
    };
    const by = held.answeredBy ?? "the person";
    if (held.status === "denied") {
      return outcome({ verdict: "refused", layer: "person", reason: `denied by ${by}` });
    }
    if (held.status === "lapsed") {
      return outcome({ verdict: "refused", layer: "person", reason: LAPSED_TEXT });
    }
    // Allowed: an answer never clears a prohibit, so the rule stage runs again first.
    const recheck = await ruleStage(call, api, context);
    if (recheck.kind === "refuse") {
      return verdict(
        call,
        `${callKey}:after-answer`,
        {
          verdict: "refused",
          layer: "rule",
          reason: recheck.reason,
          ruleId: recheck.ruleId ?? null,
          ruleLevel: recheck.ruleLevel ?? null,
          matched: recheck.matched ?? [],
        },
        started,
        context,
      );
    }
    if ((await consumeHeld(harness(), held.number, callKey, context)) === "used") {
      return outcome({ verdict: "refused", layer: "person", reason: USED_TEXT });
    }
    const how = held.status === "always" ? "always" : "once";
    return outcome({ verdict: "allowed", layer: "person", reason: `allowed ${how} by ${by}` });
  }

  return defineExtension({
    name: "secbot-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (toolCall, api, context) => {
          const started = Date.now();
          let role = "other";
          const ids = { task_id: String(api.taskId), call_id: toolCall.id };
          const callKey = `${ids.task_id}:${ids.call_id}`;
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
            const requestId =
              options.requestIdOf?.(call, api) ?? `${String(api.conversationId)}:${toolCall.id}`;
            const digest = await argumentDigest(call.arguments);
            // First, an earlier hold of this request: a rerun after a crash, or a retry. A used
            // allow-always answer is left to the rule it added.
            const earlier = await findHeld(api, requestId, digest, context);
            const reusable =
              earlier !== undefined &&
              !(
                earlier.status === "always" &&
                earlier.consumedBy !== null &&
                earlier.consumedBy !== callKey
              );
            if (earlier !== undefined && reusable) {
              return await settleHeld(earlier, call, callKey, api, started, context);
            }
            // The rule stage (always first) is timed on its own for the benchmark (`rule_ms`).
            let ruleMs: number | null = null;
            const timed = stages.map(
              (stage, index): GuardStage =>
                index > 0
                  ? stage
                  : async (...args) => {
                      const ruleStarted = performance.now();
                      try {
                        return await stage(...args);
                      } finally {
                        ruleMs = Math.round((performance.now() - ruleStarted) * 1000) / 1000;
                      }
                    },
            );
            const result = await runStages(timed, call, api, context);
            if (result.kind === "hold") {
              const matched = result.matched ?? [];
              const always = await offerFor(call, matched, api, context);
              const heldAt = options.now();
              const held = await harness().commit(
                (tx) =>
                  holdCall(
                    tx,
                    {
                      requestId,
                      callKey,
                      digest,
                      conversationId: String(api.conversationId),
                      agent: role,
                      tool: call.tool,
                      arguments: call.arguments,
                      matched,
                      reason: result.reason,
                      reasonSource:
                        result.reasonSource ??
                        (result.ruleLevel === "owner" ? "owner-rule" : "your-rule"),
                      layer: result.layer,
                      ruleId: result.ruleId ?? null,
                      ruleLevel: result.ruleLevel ?? null,
                      always,
                      heldAt,
                      expiresAt: heldAt + holdMs,
                      ...(result.model === undefined ? {} : { model: result.model }),
                    },
                    options.timeZone,
                  ),
                context,
              );
              heldEvent(person, held);
              return await settleHeld(held, call, callKey, api, started, context);
            }
            return await verdict(
              call,
              callKey,
              {
                verdict: result.kind === "pass" ? "allowed" : "refused",
                layer: result.layer,
                reason: result.reason,
                ruleId: result.ruleId ?? null,
                ruleLevel: result.ruleLevel ?? null,
                matched: result.matched ?? [],
                ruleMs,
                ...(result.model === undefined ? {} : { model: result.model }),
              },
              started,
              context,
            );
          } catch (error) {
            // An abort is not a guard failure: pi-durable settles an aborted call itself.
            if (context.abortSignal?.aborted === true) throw error;
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
                      key: `${callKey}:guard-error`,
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
