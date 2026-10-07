/**
 * Operator routes: snapshots, restores, wipes, digests, heartbeat state, and the write-delay
 * probe. Only the VPS release tool calls them, from the host, with the operator key that host
 * setup generates on the VPS (`x-secbot-operator`); every other request is refused and logged as
 * `ops.refused`. The key is compared by SHA-256 without an early exit, and never logged.
 *
 *   POST /ops/snapshot?id=<id>[&cells=]  each cell dumps; the dump goes to the SNAPSHOTS bucket
 *                                        binding as snapshots/<id>/<cell>.json
 *   POST /ops/restore?id=<id>&cell=<c>   load that dump into the cell (refuses a later contract step)
 *   POST /ops/wipe?cells=                drop every table of the cells (test cell, after a drill)
 *   GET  /ops/digest?cells=              each cell's digest and row count
 *   GET  /ops/heartbeats?cells=          each cell's heartbeat routine state
 *   POST /ops/write                      one committed single-row write (test cell only)
 *
 * The SNAPSHOTS binding is an `r2_buckets` entry: celld serves it from the fleet bucket under
 * `r2/secbot-snapshots/`, so a snapshot lives at the bucket provider, not on the VPS (celld v0.6.1
 * docs/README.md:477-481; `put(key, value, options)` and `get(key)` in
 * crates/celld/js/harness.js:1132-1190).
 */
import { type HeartbeatState, logEvent } from "@secbot/cell-harness";
import type { CellDump } from "@secbot/cell-storage";
import { sameHex, sha256Hex } from "./device-auth.ts";
import { contractStep } from "./health.ts";
import { OPERATOR_HEADER } from "./household-client.ts";

/** What the operator routes need from a cell's stub (celld JS RPC). */
export interface SnapshotStub {
  snapshot(contractStep: number): Promise<CellDump>;
  restore(dump: CellDump, person: string): Promise<{ digest: string; rows: number }>;
  wipe(): Promise<void>;
  digest(): Promise<{ digest: string; rows: number }>;
  heartbeat(person: string): Promise<HeartbeatState>;
}

/** The part of an R2 bucket binding the routes use. */
export interface SnapshotBucket {
  put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface OpsEnv {
  readonly SECBOT_OPERATOR_KEY?: string;
  readonly SNAPSHOTS?: SnapshotBucket;
}

export interface OpsDeps {
  /** The cells this fleet serves, by name. */
  readonly cells: readonly string[];
  /** The stub of one served cell, or undefined when the fleet has no binding for it. */
  stubOf(cell: string): SnapshotStub | undefined;
  /** One committed single-row write (the test cell's lab); undefined elsewhere. */
  readonly write?: () => Promise<void>;
}

const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

const refuse = (route: string, reason: string, status: number) => {
  logEvent("ops.refused", { route, reason }, "warn");
  return json({ error: `refused: ${reason}` }, status);
};

/** True when the request carries the operator key; refuses every request when none is set. */
export async function hasOperatorKey(request: Request, env: OpsEnv): Promise<boolean> {
  const expected = env.SECBOT_OPERATOR_KEY ?? "";
  const given = request.headers.get(OPERATOR_HEADER) ?? "";
  if (expected === "" || given === "") return false;
  return sameHex(await sha256Hex(given), await sha256Hex(expected));
}

/** The cells a request names (`?cells=`), each one served by this fleet; all of them by default. */
function cellsOf(url: URL, deps: OpsDeps): { cells: string[] } | { error: string } {
  const named = (url.searchParams.get("cells") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (name === "person" ? "second" : name));
  const cells = named.length === 0 ? [...deps.cells] : [...new Set(named)];
  const foreign = cells.find((cell) => !deps.cells.includes(cell));
  return foreign === undefined
    ? { cells }
    : { error: `cell ${foreign} is served by another fleet` };
}

const snapshotKey = (id: string, cell: string) => `snapshots/${id}/${cell}.json`;

/** Handles one `/ops/*` request; the caller has checked the path prefix. */
export async function ops(request: Request, env: OpsEnv, deps: OpsDeps): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (!(await hasOperatorKey(request, env))) return refuse(url.pathname, "operator_key", 401);
  const stub = (cell: string) => {
    const found = deps.stubOf(cell);
    if (found === undefined) throw new Error(`cell ${cell} has no binding in this fleet`);
    return found;
  };

  if (route === "POST /ops/write") {
    if (deps.write === undefined) return json({ error: "no write probe in this bundle" }, 404);
    const started = Date.now();
    await deps.write();
    return json({ ms: Date.now() - started });
  }

  if (route === "POST /ops/restore") {
    const id = url.searchParams.get("id") ?? "";
    const raw = url.searchParams.get("cell") ?? "";
    const cell = raw === "person" ? "second" : raw;
    if (!SNAPSHOT_ID.test(id)) return json({ error: "send id=<snapshot id>" }, 400);
    if (cell === "secrets") return refuse(url.pathname, "secrets_cell", 403);
    if (!deps.cells.includes(cell)) {
      return json({ error: `cell ${cell} is served by another fleet` }, 404);
    }
    if (env.SNAPSHOTS === undefined) return json({ error: "no SNAPSHOTS binding" }, 503);
    const object = await env.SNAPSHOTS.get(snapshotKey(id, cell));
    if (object === null) return json({ error: `snapshot ${id} not found for cell ${cell}` }, 404);
    const dump = JSON.parse(await object.text()) as CellDump;
    if (dump.contractStep > contractStep()) {
      return json(
        {
          error: `refusing a snapshot past contract step ${contractStep()} (snapshot ${id} has step ${dump.contractStep})`,
        },
        409,
      );
    }
    const result = await stub(cell).restore(dump, cell);
    return json({ cell, ...result });
  }

  const selected = cellsOf(url, deps);
  if ("error" in selected) return json({ error: selected.error }, 404);
  const { cells } = selected;

  if (route === "POST /ops/snapshot") {
    const id = url.searchParams.get("id") ?? "";
    if (!SNAPSHOT_ID.test(id)) return json({ error: "send id=<snapshot id>" }, 400);
    if (env.SNAPSHOTS === undefined) return json({ error: "no SNAPSHOTS binding" }, 503);
    const snapshots = [];
    for (const cell of cells) {
      const dump = await stub(cell).snapshot(contractStep());
      const body = JSON.stringify(dump);
      await env.SNAPSHOTS.put(snapshotKey(id, cell), body, {
        customMetadata: {
          digest: dump.digest,
          rows: String(dump.rows),
          contractStep: String(dump.contractStep),
        },
      });
      logEvent("ops.snapshot", { id, cell, bytes: body.length });
      snapshots.push({ cell, digest: dump.digest, rows: dump.rows, bytes: body.length });
    }
    return json({ id, contractStep: contractStep(), snapshots });
  }
  if (route === "POST /ops/wipe") {
    for (const cell of cells) await stub(cell).wipe();
    return json({ wiped: cells });
  }
  if (route === "GET /ops/digest") {
    const answer: Record<string, { digest: string; rows: number }> = {};
    for (const cell of cells) answer[cell] = await stub(cell).digest();
    return json({ cells: answer });
  }
  if (route === "GET /ops/heartbeats") {
    const answer: Record<string, HeartbeatState | { error: string }> = {};
    for (const cell of cells) {
      try {
        answer[cell] = await stub(cell).heartbeat(cell);
      } catch (error) {
        answer[cell] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return json({ cells: answer });
  }
  return json({ error: "not found" }, 404);
}
