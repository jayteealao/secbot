// A quick check: pi-durable's storage conformance suite against the driver over the node:sqlite
// stand-in. Release evidence is the in-cell run (`mise run test:conformance`).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { CelldSqliteDatabase } from "../src/index.ts";
import { FakeCelldStorage } from "./fake-celld-storage.ts";

registerStorageConformance(
  { describe, expect, it },
  "celld adapter (fake celld storage)",
  async (use) => {
    const storage = await SqliteStorage.open(new CelldSqliteDatabase(new FakeCelldStorage()));
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);
