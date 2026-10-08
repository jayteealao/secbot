/**
 * The owner's guard settings for one cell: the mode (shadow or enforce) and the decision model's
 * adapter. Both live in the cell's own documents, so the hook reads no other cell. Only the owner
 * changes them, through the operator routes; no device-key route reaches these functions.
 */
import type { Context } from "@earendil-works/chord";
import type { DocumentReader, Harness } from "@earendil-works/pi-durable";
import { appendRecord, recordOf } from "./activity.ts";
import { logEvent, RefusedChange } from "./cell-parts.ts";
import { DecisionModelDoc, type GuardMode, GuardModeDoc } from "./docs.ts";
import {
  DECISION_MODELS,
  DEFAULT_DECISION_ADAPTER,
  type DecisionAdapter,
} from "./release-defaults.ts";

export interface GuardModeState {
  readonly mode: GuardMode;
  /** When the current mode began; null for a cell not yet opened by this release. */
  readonly since: number | null;
  readonly switchedBy: string | null;
}

export const GUARD_MODES: readonly GuardMode[] = ["shadow", "enforce"];

export const isGuardMode = (value: unknown): value is GuardMode =>
  value === "shadow" || value === "enforce";

export const isDecisionAdapter = (value: unknown): value is DecisionAdapter =>
  typeof value === "string" && Object.hasOwn(DECISION_MODELS, value);

/** The cell's guard mode; shadow when the document does not exist yet. */
export async function readGuardMode(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<GuardModeState> {
  const doc = await reader.snapshot(GuardModeDoc, context);
  return {
    mode: doc?.mode ?? "shadow",
    since: doc?.since ?? null,
    switchedBy: doc?.switchedBy ?? null,
  };
}

/** The decision model's adapter; Clef when the document does not exist yet. */
export async function readDecisionAdapter(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<DecisionAdapter> {
  return (await reader.snapshot(DecisionModelDoc, context))?.adapter ?? DEFAULT_DECISION_ADAPTER;
}

export interface SettingsParts {
  readonly harness: Harness;
  readonly person: string;
  readonly timeZone: string;
}

/**
 * Switches the mode: one commit holds the document and one `mode` activity record, then one
 * `guard.mode` event is logged. A switch to the mode the cell already has writes and logs nothing.
 */
export async function setGuardMode(
  parts: SettingsParts,
  mode: GuardMode,
  by: string,
  now: number,
  context: Context,
): Promise<GuardModeState & { readonly changed: boolean }> {
  if (!isGuardMode(mode)) throw new RefusedChange(`the mode is shadow or enforce, not "${mode}"`);
  const result = await parts.harness.commit(async (tx) => {
    const doc = await tx.doc(GuardModeDoc);
    const from = doc.mode;
    if (from === mode) return { ...doc, from, changed: false };
    doc.mode = mode;
    doc.since = now;
    doc.switchedBy = by;
    await appendRecord(
      tx,
      recordOf({
        key: `mode:${now}:${mode}`,
        at: now,
        kind: "mode",
        agent: by,
        tool: "mode",
        verdict: "switched",
        layer: "guard",
        reason: `mode: ${from} -> ${mode}`,
        ruleId: null,
        ruleLevel: null,
        arguments: {},
        keep: [],
        cost: 0,
        mode,
      }),
      parts.timeZone,
    );
    return { ...doc, from, changed: true };
  }, context);
  if (result.changed) logEvent("guard.mode", { cell: parts.person, from: result.from, to: mode });
  return {
    mode: result.mode,
    since: result.since,
    switchedBy: result.switchedBy,
    changed: result.changed,
  };
}

/** Switches the decision model's adapter; the next call uses it. Refuses an unknown adapter. */
export async function setDecisionAdapter(
  parts: SettingsParts,
  adapter: string,
  context: Context,
): Promise<DecisionAdapter> {
  if (!isDecisionAdapter(adapter)) {
    throw new RefusedChange(
      `unknown decision model "${adapter}": use ${Object.keys(DECISION_MODELS).join(" or ")}`,
    );
  }
  const from = await parts.harness.commit(async (tx) => {
    const doc = await tx.doc(DecisionModelDoc);
    const before = doc.adapter;
    doc.adapter = adapter;
    return before;
  }, context);
  logEvent("guard.decision_model", { cell: parts.person, from, to: adapter });
  return adapter;
}
