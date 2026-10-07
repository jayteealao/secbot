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
import { RoleModelsDoc, RosterDoc } from "./docs.ts";
import {
  DEFAULT_LEAD_MODEL,
  DEFAULT_SPECIALIST_MODEL,
  GATEWAY_PROVIDER,
  LEAD_ROLE,
} from "./release-defaults.ts";

export const defaultModelFor = (role: string): string =>
  role === LEAD_ROLE ? DEFAULT_LEAD_MODEL : DEFAULT_SPECIALIST_MODEL;

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
}

/** Every role (the lead, then each specialist) with its model and where the model comes from. */
export async function listRoleModels(parts: CellParts, context: Context): Promise<RoleModel[]> {
  const overrides = (await parts.harness.snapshot(RoleModelsDoc, context))?.overrides ?? {};
  const roster = (await parts.harness.snapshot(RosterDoc, context))?.specialists ?? {};
  return [LEAD_ROLE, ...Object.keys(roster)].map((role) => {
    const changed = Object.hasOwn(overrides, role) ? overrides[role] : undefined;
    return changed === undefined
      ? { role, model: defaultModelFor(role), source: "release default" }
      : { role, model: changed, source: "changed" };
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
  return { role, model: modelId, source: "changed" };
}
