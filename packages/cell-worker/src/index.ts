// The person-cell worker's entry module: the request handler and the Durable Object classes, and
// nothing else. The cell runtime loads every named export of this module as an entry point and
// refuses the whole Worker when one is not a class, a function, or a handler object (a string
// constant here stopped the production fleet from starting). The routes live in routes.ts and the
// cell names and fleet helpers in cells.ts; test/worker-exports.test.ts holds this module to it.
import {
  HouseholdCell as HouseholdCellBase,
  type HouseholdCellEnv,
  type HouseholdCellState,
} from "@secbot/household-cell";
import {
  SecretsCell as SecretsCellBase,
  type SecretsCellEnv,
  type SecretsCellState,
} from "@secbot/secrets-cell";
import { releaseVersion } from "./health.ts";
import { PersonCell } from "./person-cell.ts";
import { route, type WorkerEnv } from "./routes.ts";

export { PersonCell };

/** The household cell with this bundle's release version. */
export class HouseholdCell extends HouseholdCellBase {
  constructor(state: HouseholdCellState, env: HouseholdCellEnv) {
    super(state, env, { version: releaseVersion() });
  }
}

/** The secrets cell with this bundle's release version and the host's key helper. */
export class SecretsCell extends SecretsCellBase {
  constructor(state: SecretsCellState, env: SecretsCellEnv) {
    super(state, env, { version: releaseVersion() });
  }
}

export default {
  fetch: (request: Request, env: WorkerEnv): Promise<Response> => route(request, env),
};
