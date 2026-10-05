// The test-cell worker: the person-cell routes plus the in-cell storage conformance run.
import { ConformanceCell } from "./conformance-cell.ts";
import { health } from "./health.ts";

export { ConformanceCell };

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface ConformanceEnv {
  readonly CONFORMANCE: DurableObjectNamespaceLike;
}

export default {
  async fetch(request: Request, env: ConformanceEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return health();
    if (url.pathname.startsWith("/conformance/")) {
      // One cell runs every case in sequence, so cases never share a database at the same time.
      return env.CONFORMANCE.get(env.CONFORMANCE.idFromName("conformance")).fetch(request);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
