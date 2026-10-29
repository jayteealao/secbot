/**
 * The role-to-model map. Release defaults (release-defaults.ts) apply wherever the owner has not
 * changed a role; the owner's changes live in the cell's `secbot.role-models` document, so a model
 * changes with no release. A change is applied with `configure()` on the role's conversation in
 * the same commit, and pi-durable fixes a request's model when it is prepared, so the change takes
 * effect from that role's next request (pi-durable README "Per-Conversation Agent").
 */
import type { Context } from "@earendil-works/chord";
import { configure, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { type CellParts, logEvent, RefusedChange } from "./cell-parts.ts";
import { RoleModelsDoc, RosterDoc, TierSettingsDoc } from "./docs.ts";
import { TIERS } from "./household-contract.ts";
import { checkAmount } from "./limits.ts";
import {
  DEFAULT_LEAD_MODEL,
  DEFAULT_REVIEWER_MODEL,
  DEFAULT_SPECIALIST_MODEL,
  GATEWAY_PROVIDER,
  LEAD_ROLE,
  REVIEWER_ROLE,
  type Tier,
} from "./release-defaults.ts";
import { capOf, isTier, tierModelOf } from "./templates.ts";

export const defaultModelFor = (role: string): string =>
  isTier(role)
    ? tierModelOf(role)
    : role === LEAD_ROLE
      ? DEFAULT_LEAD_MODEL
      : role === REVIEWER_ROLE
        ? DEFAULT_REVIEWER_MODEL
        : DEFAULT_SPECIALIST_MODEL;

export const modelRef = (modelId: string) => ({ provider: GATEWAY_PROVIDER, modelId }) as const;

/** Refuses an id the gateway's model list cannot resolve (pi-ai `Models.getModel`). */
export function assertResolvable(parts: Pick<CellParts, "models">, modelId: string): void {
  if (parts.models.getModel(GATEWAY_PROVIDER, modelId) === undefined) {
    throw new RefusedChange(
      `unknown model "${modelId}": the ${GATEWAY_PROVIDER} model list has no such id; the map is unchanged`,
    );
  }
}

export interface RoleModel {
  readonly role: string;
  readonly model: string;
  readonly source: "release default" | "changed";
  /** A tier's per-job cap in USD; only tier lines have one. */
  readonly capUsd?: number;
}

/**
 * Every role with its model and where the model comes from: the lead, each frozen specialist, the
 * three job tiers (with their per-job caps), then the guard's reviewer. The tiers and the reviewer
 * have no conversation: a job reads its tier's model when it starts or changes tier, the guard
 * reads the reviewer's per review.
 */
export async function listRoleModels(parts: CellParts, context: Context): Promise<RoleModel[]> {
  const overrides = (await parts.harness.snapshot(RoleModelsDoc, context))?.overrides ?? {};
  const roster = (await parts.harness.snapshot(RosterDoc, context))?.specialists ?? {};
  const caps = (await parts.harness.snapshot(TierSettingsDoc, context))?.caps ?? {};
  return [LEAD_ROLE, ...Object.keys(roster), ...TIERS, REVIEWER_ROLE].map((role) => {
    const changed = Object.hasOwn(overrides, role) ? overrides[role] : undefined;
    const line: RoleModel =
      changed === undefined
        ? { role, model: defaultModelFor(role), source: "release default" }
        : { role, model: changed, source: "changed" };
    return isTier(role) ? { ...line, capUsd: capOf(role, caps) } : line;
  });
}

/** Changes one role's model; refuses an unknown role or an unresolvable id before any write. */
export async function setRoleModel(
  parts: CellParts,
  role: string,
  modelId: string,
  context: Context,
): Promise<RoleModel> {
  const before = (await listRoleModels(parts, context)).find((entry) => entry.role === role);
  try {
    if (before === undefined) throw new RefusedChange(`unknown role "${role}"`);
    assertResolvable(parts, modelId);
  } catch (error) {
    logEvent("role_model.changed", {
      cell: parts.person,
      role,
      from: before?.model ?? null,
      to: modelId,
      outcome: "refused",
    });
    throw error;
  }
  await parts.harness.commit(async (tx) => {
    if (role === REVIEWER_ROLE || isTier(role)) {
      // No conversation to configure: the next review, or the next job on the tier (and the next
      // set_job onto it), reads the map. A running job keeps the model it started with.
      (await tx.doc(RoleModelsDoc)).overrides[role] = modelId;
      return;
    }
    const roster = await tx.doc(RosterDoc);
    const conversationId =
      role === LEAD_ROLE ? ROOT_CONVERSATION_ID : roster.specialists[role]?.conversationId;
    if (conversationId === undefined) throw new RefusedChange(`unknown role "${role}"`);
    (await tx.doc(RoleModelsDoc)).overrides[role] = modelId;
    await configure(tx, conversationId, { model: modelRef(modelId) });
  }, context);
  logEvent("role_model.changed", {
    cell: parts.person,
    role,
    from: before.model,
    to: modelId,
    outcome: "changed",
  });
  return { ...before, model: modelId, source: "changed" };
}

/**
 * Changes a tier's per-job cap: above 0, at most LIMIT_MAX_USD, two decimals. New jobs on the tier,
 * and a job moved onto it with set_job, take the new cap; a running job keeps its cap.
 */
export async function setTierCap(
  parts: CellParts,
  tier: string,
  usd: unknown,
  context: Context,
): Promise<{ readonly tier: Tier; readonly capUsd: number }> {
  let amount: number;
  try {
    if (!isTier(tier)) throw new RefusedChange(`unknown tier "${tier}": use ${TIERS.join(", ")}`);
    try {
      amount = checkAmount(usd);
    } catch {
      throw new RefusedChange(
        "a cap is a dollar amount above 0 and within the limit maximum, with at most two decimals",
      );
    }
  } catch (error) {
    logEvent("tier.cap_changed", { cell: parts.person, tier, outcome: "refused" });
    throw error;
  }
  let from = 0;
  await parts.harness.commit(async (tx) => {
    const settings = await tx.doc(TierSettingsDoc);
    from = capOf(tier, settings.caps);
    settings.caps[tier] = amount;
  }, context);
  logEvent("tier.cap_changed", {
    cell: parts.person,
    tier,
    from_usd: from,
    to_usd: amount,
    outcome: "changed",
  });
  return { tier, capUsd: amount };
}
