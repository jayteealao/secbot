// The cells and the fleet that serves each one.
//
// A fleet serves the cells named in SECBOT_FLEET_CELLS (empty: every cell, as on the test cell).
// Production runs the owner cell in one fleet and the second person and household cells in
// another, so each rollout stage deploys its own fleet (celld runs one application per fleet).
// Cell names follow the release workflows: `person` is the second person's cell. The secrets cell
// runs in the test fleet and beside the household cell in production; it is never snapshotted.
//
// Not in the worker entry module: the cell runtime loads every named export of the entry as an
// entry point and refuses the whole Worker when one is a string (test/worker-exports.test.ts).
import { HOUSEHOLD_CELL_NAME } from "@secbot/household-cell";
import { SECRETS_CELL_NAME } from "@secbot/secrets-cell";

/** The person cells. */
export const PERSONS: readonly string[] = ["owner", "second"];
/** The household cell's name, the same one the household cell package uses. */
export const HOUSEHOLD = HOUSEHOLD_CELL_NAME;
/** The secrets cell's name, the same one the secrets cell package uses. */
export const SECRETS = SECRETS_CELL_NAME;
/** Every cell. */
export const ALL_CELLS: readonly string[] = [...PERSONS, HOUSEHOLD, SECRETS];

/** The release workflows' name for the second person's cell. */
export const cellName = (name: string): string => (name === "person" ? "second" : name);

/** The cells this fleet serves: SECBOT_FLEET_CELLS, or every cell when it is empty. */
export function fleetCells(env: { readonly SECBOT_FLEET_CELLS?: string }): string[] {
  const named = (env.SECBOT_FLEET_CELLS ?? "")
    .split(",")
    .map((name) => cellName(name.trim()))
    .filter(Boolean);
  return named.length === 0 ? [...ALL_CELLS] : [...new Set(named)];
}

export const anotherFleet = (cell: string) => `cell ${cell} is served by another fleet`;
