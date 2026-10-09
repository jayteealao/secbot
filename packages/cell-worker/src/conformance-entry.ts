// The test-cell worker: the person-cell routes, the household and secrets cells, the in-cell storage
// conformance run, and the durability lab.
import { ConformanceCell } from "./conformance-cell.ts";
import { DurabilityLabCell } from "./durability-lab.ts";
import {
  type DurableObjectNamespaceLike,
  HouseholdCell,
  type LabNamespaceLike,
  PersonCell,
  route,
  SecretsCell,
  type WorkerEnv,
} from "./index.ts";

export type { DurableObjectNamespaceLike, DurableObjectStubLike } from "./index.ts";
export { ConformanceCell, DurabilityLabCell, HouseholdCell, PersonCell, SecretsCell };

export interface ConformanceEnv extends Partial<WorkerEnv> {
  readonly CONFORMANCE: DurableObjectNamespaceLike;
  readonly LAB?: LabNamespaceLike;
}

const NO_PERSON_CELL: DurableObjectNamespaceLike = {
  idFromName: (name) => name,
  get: () => ({
    fetch: async () => Response.json({ error: "no PERSON_CELL binding" }, { status: 503 }),
  }),
};

export default {
  async fetch(request: Request, env: ConformanceEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/conformance/")) {
      // One cell runs every case in sequence, so cases never share a database at the same time.
      return env.CONFORMANCE.get(env.CONFORMANCE.idFromName("conformance")).fetch(request);
    }
    if (url.pathname.startsWith("/lab/")) {
      if (env.LAB === undefined) return Response.json({ error: "no LAB binding" }, { status: 503 });
      return env.LAB.get(env.LAB.idFromName("lab")).fetch(request);
    }
    return route(request, { ...env, PERSON_CELL: env.PERSON_CELL ?? NO_PERSON_CELL });
  },
};
