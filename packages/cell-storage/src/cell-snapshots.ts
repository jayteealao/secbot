/**
 * The snapshot operations every cell kind shares (person cells and the household cell): dump,
 * digest, restore, and wipe, each through the right runner, plus a gate that keeps the cell from
 * opening its harness while its database is being replaced.
 *
 * A restore or a wipe closes the cell's harness and then rewrites the database. An event that
 * arrives in between (a request, an alarm) would otherwise open a harness on the old database and
 * keep its in-memory state after the load. The cell's open path waits on `idle()` first, so that
 * event opens the harness on the restored database instead.
 */
import type { CelldCellStorage } from "./celld-types.ts";
import {
  type CellDump,
  databaseRunner,
  digestCell,
  dumpCell,
  loadCell,
  type SnapshotRunner,
  storageRunner,
  type TransactionalDatabase,
  wipeCell,
} from "./snapshot.ts";

export interface SnapshotHost {
  /** The open storage driver while the cell's harness is open (or opening), else undefined. */
  openDatabase(): Promise<TransactionalDatabase | undefined>;
  /** Closes the cell's harness; the next event opens it again. */
  close(): Promise<void>;
}

export class CellSnapshots {
  private gate: Promise<void> | undefined;

  constructor(
    private readonly storage: CelldCellStorage,
    private readonly host: SnapshotHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves once no restore or wipe is running; the cell's open path awaits it. */
  async idle(): Promise<void> {
    while (this.gate !== undefined) await this.gate;
  }

  /** Runs `work` alone: other restores, wipes, and harness opens wait until it ends. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    // The loop re-checks after every wait, and the gate is set with no await in between, so two
    // callers never both pass.
    while (this.gate !== undefined) await this.gate;
    let release: () => void = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await work();
    } finally {
      this.gate = undefined;
      release();
    }
  }

  /** The open driver's queue when the harness is open, else a transaction on the storage itself. */
  private async runner(): Promise<SnapshotRunner> {
    const database = await this.host.openDatabase();
    return database === undefined ? storageRunner(this.storage) : databaseRunner(database);
  }

  /** The whole database as one dump, taken in one transaction. */
  async snapshot(contractStep: number): Promise<CellDump> {
    return dumpCell(await this.runner(), { contractStep, now: this.now });
  }

  /** The database digest and row count as they are now. */
  async digest(): Promise<{ digest: string; rows: number }> {
    return digestCell(await this.runner());
  }

  /**
   * Closes the harness and replaces the database with `dump` in one transaction checked against
   * the dump's digest. The caller reopens the harness afterwards; opens wait until the load ends.
   */
  restore(dump: CellDump): Promise<{ digest: string; rows: number }> {
    return this.exclusive(async () => {
      await this.host.close();
      return loadCell(storageRunner(this.storage), dump);
    });
  }

  /** Closes the harness and drops every table and the alarm. */
  wipe(): Promise<void> {
    return this.exclusive(async () => {
      await this.host.close();
      await wipeCell(storageRunner(this.storage));
      await this.storage.deleteAlarm();
    });
  }
}
