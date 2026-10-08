/**
 * `ConformanceCell`: a Durable Object that runs pi-durable's storage conformance suite against
 * `CelldSqliteDatabase` inside a real celld cell. Deployed only to the test cell
 * (wrangler.conformance.jsonc), never to the person cells.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import {
  CelldSqliteDatabase,
  type CelldStorage,
  CellStorageTransactionTimeout,
} from "@secbot/cell-storage";
import { cellAssertions } from "./cell-assertions.ts";

export interface DurableObjectStateLike {
  readonly storage: CelldStorage;
}

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
}

export interface ConformanceReport {
  readonly adapter: string;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly CaseResult[];
}

export interface LongTransactionReport {
  readonly adapter: string;
  readonly timedOut: boolean;
  readonly error: string;
  readonly durationMs: number;
  /** Marker rows read after the transaction ended; null when the reset closed this event's storage. */
  readonly markerRowsVisible: number | null;
}

const MARKER_TABLE =
  "CREATE TABLE IF NOT EXISTS conformance_marker (id INTEGER PRIMARY KEY, at INTEGER)";

const message = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Runs every conformance case in order; each case gets a wiped database and a fresh driver. */
export async function runConformance(
  storage: CelldStorage,
  onCase?: (result: CaseResult) => void,
): Promise<ConformanceReport> {
  const adapters = new Set<string>();
  const cases = createStorageConformance({
    assertions: cellAssertions,
    withStorage: async (use) => {
      await storage.deleteAll();
      const database = new CelldSqliteDatabase(storage);
      adapters.add(database.adapter);
      const durable = await SqliteStorage.open(database);
      try {
        await use(durable);
      } finally {
        await durable.close(BACKGROUND_CONTEXT);
      }
    },
  });
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const started = Date.now();
    let result: CaseResult;
    try {
      await testCase.run();
      result = { name: testCase.name, ok: true, ms: Date.now() - started };
    } catch (error) {
      result = { name: testCase.name, ok: false, ms: Date.now() - started, error: message(error) };
    }
    results.push(result);
    onCase?.(result);
  }
  await storage.deleteAll();
  const failed = results.filter((result) => !result.ok).length;
  // A run where any case used another driver reports that driver, so the caller's check fails.
  const adapter =
    adapters.size === 1 ? ([...adapters][0] ?? "none") : [...adapters].join(",") || "none";
  return { adapter, passed: results.length - failed, failed, cases: results };
}

async function countMarkers(storage: CelldStorage): Promise<number> {
  const database = new CelldSqliteDatabase(storage);
  await database.exec(MARKER_TABLE);
  const row = await database.get<{ n: number }>("SELECT count(*) AS n FROM conformance_marker");
  return Number(row?.n ?? 0);
}

/**
 * Opens a transaction that writes a marker row and then waits `holdMs`. Past celld's 30-second
 * limit, celld resets the cell; the report says whether the driver reported a timeout and how
 * many marker rows are visible afterwards (0 means no partial write).
 */
export async function runLongTransaction(
  storage: CelldStorage,
  holdMs: number,
  reopen: () => CelldStorage = () => storage,
): Promise<LongTransactionReport> {
  const database = new CelldSqliteDatabase(storage);
  await database.exec(MARKER_TABLE);
  await database.run("DELETE FROM conformance_marker");
  const started = Date.now();
  let error: unknown;
  try {
    await database.transaction(async (tx) => {
      await tx.run("INSERT INTO conformance_marker (at) VALUES (?)", started);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    });
  } catch (caught) {
    error = caught;
  }
  const durationMs = Date.now() - started;
  // After a reset, celld closes this event's storage; the caller then reads GET /conformance/marker.
  const markerRowsVisible = await countMarkers(reopen()).catch(() => null);
  return {
    adapter: database.adapter,
    timedOut: error instanceof CellStorageTransactionTimeout,
    error: error === undefined ? "" : message(error),
    durationMs,
    markerRowsVisible,
  };
}

export class ConformanceCell {
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/conformance/run") {
      return Response.json(
        await runConformance(this.state.storage, (result) => console.log(JSON.stringify(result))),
      );
    }
    if (request.method === "POST" && url.pathname === "/conformance/long-transaction") {
      const holdMs = Number(url.searchParams.get("ms") ?? "31000");
      if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 120_000) {
        return Response.json({ error: "ms must be an integer from 0 to 120000" }, { status: 400 });
      }
      return Response.json(await runLongTransaction(this.state.storage, holdMs));
    }
    if (request.method === "GET" && url.pathname === "/conformance/marker") {
      return Response.json({ markerRowsVisible: await countMarkers(this.state.storage) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
