/**
 * Household document tools for the lead and every specialist: `household_read` and
 * `household_change`. They reach the household cell through a `HouseholdClient` (celld JS RPC in
 * a person cell). Each change carries an operation id made from this cell, the tool task, and the
 * model's call id: all three are durable, so a call that reruns after a crash sends the same id,
 * and the household cell applies it once (celld retries an RPC only when the method never started;
 * source: .scratch/sources/git/celld tag v0.6.1, docs/cloudflare-compat.md:95-99).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import {
  DEFAULT_HOUSEHOLD_DOCUMENT,
  HOUSEHOLD_DOCUMENT,
  type HouseholdChange,
  type HouseholdClient,
} from "./household-contract.ts";

const UNREACHABLE = "The household cell is not reachable from here.";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function createHouseholdExtension(
  cell: string,
  client: () => HouseholdClient | undefined,
): Extension {
  const documentParameter = Type.Optional(
    Type.String({ description: 'The document, default "list" (the household list).' }),
  );
  const read = defineTool({
    name: "household_read",
    description:
      "Read a shared household document, such as the household list, that both people in the household see. Returns each item with its id.",
    parameters: Type.Object({ document: documentParameter }),
    replay: "safe",
    execute: async (args) => {
      const document = args.document ?? DEFAULT_HOUSEHOLD_DOCUMENT;
      if (!HOUSEHOLD_DOCUMENT.test(document)) {
        return { ...text(`No document named "${document}".`), isError: true };
      }
      const household = client();
      if (household === undefined) return { ...text(UNREACHABLE), isError: true };
      const found = await household.read(document);
      const lines = found.items.map(
        (item) => `- [${item.done ? "x" : " "}] ${item.text} (id ${item.itemId})`,
      );
      return {
        ...text(
          lines.length === 0
            ? `The ${document} is empty.`
            : [`The ${document}:`, ...lines].join("\n"),
        ),
        details: { document, items: found.items.length },
      };
    },
  });
  const change = defineTool({
    name: "household_change",
    description:
      "Change one item of a shared household document: add an item, edit an item's text or done mark, or remove an item. Changes by both people merge per item; for the same item the later change wins.",
    parameters: Type.Object({
      document: documentParameter,
      op: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("remove")]),
      itemId: Type.Optional(Type.String({ description: "The item's id (edit, remove)." })),
      text: Type.Optional(Type.String({ description: "The item's text (add, edit)." })),
      done: Type.Optional(Type.Boolean({ description: "Mark the item done or not (edit)." })),
    }),
    // The operation id is the same on a rerun, so the household cell applies the change once.
    replay: "safe",
    execute: async (args, api) => {
      const document = args.document ?? DEFAULT_HOUSEHOLD_DOCUMENT;
      if (!HOUSEHOLD_DOCUMENT.test(document)) {
        return { ...text(`No document named "${document}".`), isError: true };
      }
      const household = client();
      if (household === undefined) return { ...text(UNREACHABLE), isError: true };
      const base = { opId: `${cell}:${api.taskId}:${api.callId}`, document, fromCell: cell };
      let request: HouseholdChange;
      if (args.op === "add") {
        if (args.text === undefined || args.text.trim() === "") {
          return { ...text("An add needs the item's text."), isError: true };
        }
        request = { ...base, kind: "add", text: args.text };
      } else if (args.itemId === undefined) {
        return { ...text(`An ${args.op} needs the item's id.`), isError: true };
      } else if (args.op === "edit") {
        if (args.text === undefined && args.done === undefined) {
          return { ...text("An edit needs a new text or a done mark."), isError: true };
        }
        request = {
          ...base,
          kind: "edit",
          itemId: args.itemId,
          ...(args.text === undefined ? {} : { text: args.text }),
          ...(args.done === undefined ? {} : { done: args.done }),
        };
      } else {
        request = { ...base, kind: "remove", itemId: args.itemId };
      }
      const result = await household.apply(request);
      const said =
        result.outcome === "missing"
          ? `No item ${result.itemId} in the ${document}; nothing changed.`
          : `${result.kind === "add" ? "Added" : result.kind === "edit" ? "Changed" : "Removed"} item ${result.itemId} in the ${document}.`;
      return {
        ...text(said),
        details: {
          outcome: result.outcome,
          itemId: result.itemId,
          seq: result.seq,
          duplicate: result.duplicate,
        },
      };
    },
  });
  return defineExtension({ name: "secbot-household", tools: [read, change] });
}

export type {
  HouseholdApplyResult,
  HouseholdChange,
  HouseholdClient,
  HouseholdDocument,
  HouseholdItem,
} from "./household-contract.ts";
