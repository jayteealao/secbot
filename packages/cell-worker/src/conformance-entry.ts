// The test-cell worker: the person-cell routes, the household and secrets cells, the in-cell storage
// conformance run, the durability lab, the guard bench, and the fake health target for the
// secrets cell's broker.
import { logEvent } from "@secbot/cell-harness";
import { ConformanceCell } from "./conformance-cell.ts";
import { DurabilityLabCell } from "./durability-lab.ts";
import { GuardBenchCell } from "./guard-bench.ts";
import {
  type DurableObjectNamespaceLike,
  HouseholdCell,
  type LabNamespaceLike,
  PersonCell,
  route,
  SecretsCell,
  type WorkerEnv,
} from "./index.ts";
import { hasOperatorKey } from "./ops.ts";

export type { DurableObjectNamespaceLike, DurableObjectStubLike } from "./index.ts";
export {
  ConformanceCell,
  DurabilityLabCell,
  GuardBenchCell,
  HouseholdCell,
  PersonCell,
  SecretsCell,
};

export interface ConformanceEnv extends Partial<WorkerEnv> {
  readonly CONFORMANCE: DurableObjectNamespaceLike;
  readonly LAB?: LabNamespaceLike;
  readonly GUARD_BENCH?: LabNamespaceLike;
}

const NO_PERSON_CELL: DurableObjectNamespaceLike = {
  idFromName: (name) => name,
  get: () => ({
    fetch: async () => Response.json({ error: "no PERSON_CELL binding" }, { status: 503 }),
  }),
};

// Not exported: the cell runtime loads every named export of this module as an entry point and
// refuses a string.
const FAKE_TARGET_PREFIX = "/fake-target";

/**
 * The fake health target (test cell only): it refuses a call without an `authorization` header
 * and echoes the header back, so the secrets cell's token redaction runs on a real answer that
 * carries the token.
 */
export function fakeTarget(request: Request, url: URL): Response {
  const header = request.headers.get("authorization");
  if (header === null || header === "") {
    return Response.json({ ok: false, error: "no authorization header" }, { status: 401 });
  }
  return Response.json({
    ok: true,
    path: url.pathname.slice(FAKE_TARGET_PREFIX.length) || "/",
    echoed: header,
  });
}

export default {
  async fetch(request: Request, env: ConformanceEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/conformance/")) {
      // One cell runs every case in sequence, so cases never share a database at the same time.
      return env.CONFORMANCE.get(env.CONFORMANCE.idFromName("conformance")).fetch(request);
    }
    if (url.pathname === FAKE_TARGET_PREFIX || url.pathname.startsWith(`${FAKE_TARGET_PREFIX}/`)) {
      return fakeTarget(request, url);
    }
    if (url.pathname.startsWith("/lab/guard-bench")) {
      // The guard bench makes paid model calls: only the operator key starts or reads it.
      if (!(await hasOperatorKey(request, env))) {
        logEvent("ops.refused", { route: url.pathname, reason: "operator_key" }, "warn");
        return Response.json({ error: "refused: operator_key" }, { status: 401 });
      }
      if (env.GUARD_BENCH === undefined) {
        return Response.json({ error: "no GUARD_BENCH binding" }, { status: 503 });
      }
      return env.GUARD_BENCH.get(env.GUARD_BENCH.idFromName("bench")).fetch(request);
    }
    if (url.pathname.startsWith("/lab/")) {
      if (env.LAB === undefined) return Response.json({ error: "no LAB binding" }, { status: 503 });
      return env.LAB.get(env.LAB.idFromName("lab")).fetch(request);
    }
    return route(request, { ...env, PERSON_CELL: env.PERSON_CELL ?? NO_PERSON_CELL });
  },
};
