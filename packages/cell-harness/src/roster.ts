/**
 * The roster: the lead's root conversation, and the specialists a cell had before jobs. Each job
 * now runs in a fresh conversation from a template (job-task.ts); the old specialist conversations
 * are frozen: no tool reaches them, they keep their transcripts (the lead's history holds every
 * answer they gave, relayed as `[handoff <name> answered]`), and each owner-added specialist's
 * instruction becomes a custom template that starts on the cheap tier.
 */
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  configure,
  ROOT_CONVERSATION_ID,
  type Tx,
} from "@earendil-works/pi-durable";
import { type CellParts, logEvent, RefusedChange } from "./cell-parts.ts";
import { RoleModelsDoc, RosterDoc, TemplatesDoc } from "./docs.ts";
import { defaultModelFor, modelRef } from "./model-map.ts";
import { LEAD_INSTRUCTIONS, LEAD_ROLE, REVIEWER_ROLE, TIERS } from "./release-defaults.ts";
import { templatesOf } from "./templates.ts";

export const SPECIALIST_NAME = /^[a-z][a-z0-9-]{1,31}$/;

/** A template's instruction is its jobs' system prompt on every call, so its size is capped. */
export const INSTRUCTION_LIMIT = 4_000;

/** Why a template takes no model (D-048): the owner maps tiers to models, the lead picks the tier. */
export const TEMPLATE_MODEL_REFUSAL =
  "a template starts on a tier; the lead picks the tier per job and the owner maps tiers to models";

/** Writes a role's agent: model from the map, the role's extensions, and its instructions. */
async function applyAgent(
  parts: CellParts,
  tx: Tx,
  conversationId: ConversationId,
  role: string,
  instruction: string,
): Promise<void> {
  const overrides = (await tx.doc(RoleModelsDoc)).overrides;
  const modelId = Object.hasOwn(overrides, role) ? overrides[role] : undefined;
  await configure(tx, conversationId, {
    model: modelRef(modelId ?? defaultModelFor(role)),
    extensions: role === LEAD_ROLE ? parts.extensions.lead : parts.extensions.specialist,
    instructions: instruction,
  });
}

/**
 * Re-applies the lead's agent on each open, so a release's tools and instructions reach it, and
 * re-applies each frozen specialist's agent (the job list, which has no tool that starts work).
 * An owner-added specialist without a custom template gets one (its instruction, the cheap tier).
 * Creates no conversation. Returns the number of templates it added.
 */
export async function ensureRoster(parts: CellParts, context: Context): Promise<number> {
  const added: string[] = [];
  await parts.harness.commit(async (tx) => {
    const roster = await tx.doc(RosterDoc);
    await applyAgent(parts, tx, ROOT_CONVERSATION_ID, LEAD_ROLE, LEAD_INSTRUCTIONS);
    const templates = await tx.doc(TemplatesDoc);
    const names = new Set(templatesOf(templates.custom).map((template) => template.name));
    for (const [name, record] of Object.entries(roster.specialists)) {
      await applyAgent(parts, tx, record.conversationId, name, record.instruction);
      if (record.builtIn || names.has(name)) continue;
      templates.custom[name] = { instruction: record.instruction, tier: "cheap" };
      names.add(name);
      added.push(name);
    }
  }, context);
  for (const name of added) {
    logEvent("template.migrated", { cell: parts.person, name, start_tier: "cheap" });
  }
  return added.length;
}

/**
 * Adds a custom job template (the owner's `secbot specialist add`): the lead can start jobs from it
 * from its next request. A template starts on the cheap tier; a model is refused (D-048).
 */
export async function addTemplate(
  parts: CellParts,
  input: { readonly name: string; readonly instruction: string; readonly model?: string },
  context: Context,
): Promise<void> {
  const refuse = (reason: string): never => {
    logEvent("specialist.added", {
      cell: parts.person,
      name: input.name,
      model: input.model ?? null,
      outcome: "refused",
    });
    throw new RefusedChange(reason);
  };
  if (input.model !== undefined) refuse(TEMPLATE_MODEL_REFUSAL);
  if (input.name === REVIEWER_ROLE) {
    refuse(`bad name "${input.name}": the reviewer is the guard's role, not a template`);
  }
  if ((TIERS as readonly string[]).includes(input.name)) {
    refuse(`bad name "${input.name}": that is a tier's name`);
  }
  if (!SPECIALIST_NAME.test(input.name) || input.name === LEAD_ROLE) {
    refuse(`bad name "${input.name}": use 2-32 lowercase letters, digits, or dashes`);
  }
  if (input.instruction.trim() === "") refuse("an instruction is required");
  if (input.instruction.length > INSTRUCTION_LIMIT) {
    refuse(`the instruction is longer than ${INSTRUCTION_LIMIT} characters`);
  }
  await parts.harness.commit(async (tx) => {
    const templates = await tx.doc(TemplatesDoc);
    const roster = await tx.doc(RosterDoc);
    if (
      templatesOf(templates.custom).some((template) => template.name === input.name) ||
      Object.hasOwn(roster.specialists, input.name)
    ) {
      refuse(`a template named "${input.name}" already exists`);
    }
    templates.custom[input.name] = { instruction: input.instruction.trim(), tier: "cheap" };
  }, context);
  logEvent("specialist.added", {
    cell: parts.person,
    name: input.name,
    model: null,
    start_tier: "cheap",
    outcome: "added",
  });
}
