import { describe, expect, it } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { ConformanceCell, runConformance, runLongTransaction } from "../src/conformance-cell.ts";
import conformanceWorker, { type ConformanceEnv } from "../src/conformance-entry.ts";
import worker, { type WorkerEnv } from "../src/index.ts";

const post = (path: string) => new Request(`http://cell${path}`, { method: "POST" });

describe("ConformanceCell", () => {
  it("runs every pi-durable storage conformance case with the celld driver", async () => {
    const seen: string[] = [];
    const report = await runConformance(new FakeCelldStorage(), (result) => seen.push(result.name));
    expect(report.adapter).toBe("CelldSqliteDatabase");
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(10);
    expect(seen).toHaveLength(report.passed);
  });

  it("reports a failing case with its message", async () => {
    const storage = new FakeCelldStorage();
    let calls = 0;
    const real = storage.deleteAll.bind(storage);
    storage.deleteAll = async () => {
      calls++;
      if (calls === 2) throw new Error("wipe failed");
      await real();
    };
    const report = await runConformance(storage);
    expect(report.failed).toBe(1);
    expect(report.cases.find((result) => !result.ok)?.error).toContain("wipe failed");
  });

  it("reports a timed-out long transaction with no marker row visible", async () => {
    const storage = new FakeCelldStorage({ transactionLimitMs: 20 });
    const report = await runLongTransaction(storage, 100);
    expect(report).toMatchObject({
      adapter: "CelldSqliteDatabase",
      timedOut: true,
      markerRowsVisible: null,
    });
    expect(report.error).toContain("CellStorageTransactionTimeout");
    const fresh = storage.database.prepare("SELECT count(*) AS n FROM conformance_marker").get();
    expect(fresh).toMatchObject({ n: 0 });
  });

  it("reports a short transaction as committed", async () => {
    const report = await runLongTransaction(new FakeCelldStorage(), 1);
    expect(report).toMatchObject({ timedOut: false, error: "", markerRowsVisible: 1 });
  });

  it("serves its routes", async () => {
    const cell = new ConformanceCell({ storage: new FakeCelldStorage() }, {});
    const run = (await (await cell.fetch(post("/conformance/run"))).json()) as {
      failed: number;
      adapter: string;
    };
    expect(run).toMatchObject({ failed: 0, adapter: "CelldSqliteDatabase" });
    const long = await (await cell.fetch(post("/conformance/long-transaction?ms=1"))).json();
    expect(long).toMatchObject({ timedOut: false });
    const marker = await (await cell.fetch(new Request("http://cell/conformance/marker"))).json();
    expect(marker).toEqual({ markerRowsVisible: 1 });
    expect((await cell.fetch(post("/conformance/long-transaction?ms=-1"))).status).toBe(400);
    expect((await cell.fetch(post("/conformance/nope"))).status).toBe(404);
  });
});

describe("worker entries", () => {
  it("reports health with the version and the driver", async () => {
    const env: WorkerEnv = {
      PERSON_CELL: {
        idFromName: (name) => name,
        get: () => ({ fetch: async () => Response.json({}, { status: 500 }) }),
      },
    };
    const response = await worker.fetch(new Request("http://cell/health"), env);
    expect(await response.json()).toEqual({ version: "0.0.0-dev", adapter: "CelldSqliteDatabase" });
    expect((await worker.fetch(new Request("http://cell/conformance/run"), env)).status).toBe(404);
  });

  it("routes conformance requests to one named cell on the test cell", async () => {
    const cell = new ConformanceCell({ storage: new FakeCelldStorage() }, {});
    const names: string[] = [];
    const env: ConformanceEnv = {
      CONFORMANCE: {
        idFromName: (name) => {
          names.push(name);
          return name;
        },
        get: () => cell,
      },
    };
    const marker = await conformanceWorker.fetch(
      new Request("http://cell/conformance/marker"),
      env,
    );
    expect(await marker.json()).toEqual({ markerRowsVisible: 0 });
    expect(names).toEqual(["conformance"]);
    expect((await conformanceWorker.fetch(new Request("http://cell/health"), env)).status).toBe(
      200,
    );
    expect((await conformanceWorker.fetch(new Request("http://cell/other"), env)).status).toBe(404);
  });
});
