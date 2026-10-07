/**
 * The household contract: the shapes a person cell and the household cell exchange over RPC (a
 * document, its items, one single-item change, the result of applying it) and the name rules both
 * sides check. It has no imports, so the household cell, the person cell's tools, and any client
 * use one definition.
 */

/** A cell name: owner, second, household, and later cells. */
export const CELL_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const HOUSEHOLD_DOCUMENT = /^[a-z][a-z0-9-]{0,31}$/;
export const DEFAULT_HOUSEHOLD_DOCUMENT = "list";

export interface HouseholdItem {
  readonly itemId: string;
  readonly text: string;
  readonly done: boolean;
  readonly version: number;
  /** The change-log position of the change that last wrote the item. */
  readonly updatedSeq: number;
}

export interface HouseholdDocument {
  readonly document: string;
  readonly items: readonly HouseholdItem[];
}

interface ChangeBase {
  readonly opId: string;
  readonly document: string;
  readonly fromCell: string;
}

export type HouseholdChange =
  | (ChangeBase & { readonly kind: "add"; readonly text: string })
  | (ChangeBase & {
      readonly kind: "edit";
      readonly itemId: string;
      readonly text?: string;
      readonly done?: boolean;
    })
  | (ChangeBase & { readonly kind: "remove"; readonly itemId: string });

export interface HouseholdApplyResult {
  /** `missing`: an edit or remove of an item that does not exist (or was removed). */
  readonly outcome: "applied" | "missing";
  readonly kind: HouseholdChange["kind"];
  readonly itemId: string;
  /** The change's position in the household cell's ordered log. */
  readonly seq: number;
  /** True when this operation id was applied before; nothing changed this time. */
  readonly duplicate: boolean;
}

/** What a person cell uses to reach the household cell. */
export interface HouseholdClient {
  read(document: string): Promise<HouseholdDocument>;
  apply(change: HouseholdChange): Promise<HouseholdApplyResult>;
}
