/**
 * The roster: the lead's root conversation plus one persistent subagent conversation per
 * specialist. Each specialist conversation is owned by a background anchor task, so the lead's
 * aborts and idle waits never reach it (pattern: pi-durable v1.0.3
 * test/examples/23-subagent-background.ts, the `Anchor` task).
 */
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  configure,
  ROOT_CONVERSATION_ID,
  type Tx,
} from "@earendil-works/pi-durable";
import { type CellParts, logEvent, RefusedChange } from "./cell-parts.ts";
import { RoleModelsDoc, RosterDoc } from "./docs.ts";
import { Anchor } from "./handoff.ts";
import { assertResolvable, defaultModelFor, modelRef } from "./model-map.ts";
import { LEAD_INSTRUCTIONS, LEAD_ROLE, STARTER_SPECIALISTS } from "./release-defaults.ts";

export const SPECIALIST_NAME = /^[a-z][a-z0-9-]{1,31}$/;

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

async function createSpecialist(
  parts: CellParts,
  tx: Tx,
  name: string,
  instruction: string,
  builtIn: boolean,
): Promise<void> {
  const roster = await tx.doc(RosterDoc);
  const anchorTaskId = await tx.createTask(Anchor, null, {
    ownership: { kind: "conversation" },
    conversationId: ROOT_CONVERSATION_ID,
    background: true,
  });
  const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchorTaskId } });
  roster.specialists[name] = {
    conversationId: child.id,
    instruction,
    anchorTaskId,
    builtIn,
    reported: [],
  };
  await applyAgent(parts, tx, child.id, name, instruction);
}

/**
 * Creates the four starter specialists once and re-applies every role's agent on each open, so
 * a release's new defaults, tools, and instructions reach existing conversations. Idempotent.
 * Returns the number of specialists created.
 */
export async function ensureRoster(parts: CellParts, context: Context): Promise<number> {
  return parts.harness.commit(async (tx) => {
    const roster = await tx.doc(RosterDoc);
    let created = 0;
    for (const starter of STARTER_SPECIALISTS) {
      if (Object.hasOwn(roster.specialists, starter.name)) continue;
      await createSpecialist(parts, tx, starter.name, starter.instruction, true);
      created++;
    }
    await applyAgent(parts, tx, ROOT_CONVERSATION_ID, LEAD_ROLE, LEAD_INSTRUCTIONS);
    for (const starter of STARTER_SPECIALISTS) {
      const record = roster.specialists[starter.name];
      if (record !== undefined) {
        record.instruction = starter.instruction;
        await applyAgent(parts, tx, record.conversationId, starter.name, starter.instruction);
      }
    }
    return created;
  }, context);
}

/** Adds a specialist the lead can hand work to from its next request. */
export async function addSpecialist(
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
  if (!SPECIALIST_NAME.test(input.name) || input.name === LEAD_ROLE) {
    refuse(`bad name "${input.name}": use 2-32 lowercase letters, digits, or dashes`);
  }
  if (input.instruction.trim() === "") refuse("an instruction is required");
  if (input.model !== undefined) {
    try {
      assertResolvable(parts, input.model);
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }
  }
  await parts.harness.commit(async (tx) => {
    const roster = await tx.doc(RosterDoc);
    if (Object.hasOwn(roster.specialists, input.name)) {
      refuse(`a specialist named "${input.name}" already exists`);
    }
    if (input.model !== undefined)
      (await tx.doc(RoleModelsDoc)).overrides[input.name] = input.model;
    await createSpecialist(parts, tx, input.name, input.instruction.trim(), false);
  }, context);
  logEvent("specialist.added", {
    cell: parts.person,
    name: input.name,
    model: input.model ?? defaultModelFor(input.name),
    outcome: "added",
  });
}
