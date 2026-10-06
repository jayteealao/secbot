// The test-cell worker: the person-cell routes plus the in-cell storage conformance run.
import { ConformanceCell } from "./conformance-cell.ts";
import { type DurableObjectNamespaceLike, PersonCell, route, type WorkerEnv } from "./index.ts";

export type { DurableObjectNamespaceLike, DurableObjectStubLike } from "./index.ts";
export { ConformanceCell, PersonCell };

export interface ConformanceEnv extends Partial<WorkerEnv> {
  readonly CONFORMANCE: DurableObjectNamespaceLike;
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
    return route(request, { ...env, PERSON_CELL: env.PERSON_CELL ?? NO_PERSON_CELL });
  },
};
