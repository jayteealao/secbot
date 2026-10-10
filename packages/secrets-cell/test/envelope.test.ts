// Envelope encryption and rotation on the stand-in custody: a raw record holds only ciphertext, a
// wrapped data key, a key id, and non-secret salt and IVs; a ciphertext moved to another person's
// or another name's record does not decrypt; two seals of one value share nothing; and a rotation
// re-wraps every record under the new key while a read between its batches still decrypts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { fromBase64, openSealed, rewrap, seal } from "../src/envelope.ts";
import { testCustody } from "../src/key-custody.ts";
import { SecretsCell } from "../src/secrets-cell.ts";

const VALUE = "test-secret-value-1234"; // gitleaks:allow (fake test value)

const cells: SecretsCell[] = [];
afterEach(async () => {
  for (const cell of cells.splice(0)) await cell.close();
  vi.restoreAllMocks();
});

describe("seal and open", () => {
  it("keeps only ciphertext, a wrapped data key, a key id, and the salt and IVs", async () => {
    const custody = testCustody();
    const record = await seal("owner", "test-secret", VALUE, custody);
    expect(Object.keys(record).sort()).toEqual(
      ["ciphertext", "iv", "keyId", "name", "person", "salt", "wrapIv", "wrappedKey"].sort(),
    );
    expect(record.keyId).toBe("k1");
    expect(JSON.stringify(record)).not.toContain(VALUE);
    expect(fromBase64(record.iv)).toHaveLength(12);
    expect(fromBase64(record.wrapIv)).toHaveLength(12);
    expect(fromBase64(record.salt)).toHaveLength(16);
    // 32 data-key bytes plus the 16-byte tag.
    expect(fromBase64(record.wrappedKey)).toHaveLength(48);
    expect(await openSealed(record, custody)).toBe(VALUE);
  });

  it("refuses a ciphertext copied to another person's or another name's record", async () => {
    const custody = testCustody();
    const record = await seal("owner", "test-secret", VALUE, custody);
    await expect(openSealed({ ...record, person: "second" }, custody)).rejects.toThrow();
    await expect(openSealed({ ...record, name: "other-secret" }, custody)).rejects.toThrow();
    // The ciphertext alone, moved into a record of its own under another name.
    const other = await seal("second", "test-secret", "another-value-5678", custody);
    await expect(
      openSealed({ ...other, ciphertext: record.ciphertext }, custody),
    ).rejects.toThrow();
    await expect(openSealed({ ...record, keyId: "k2" }, custody)).rejects.toThrow();
  });

  it("never repeats a salt, an IV, a wrapped key, or a ciphertext for one value", async () => {
    const custody = testCustody();
    const one = await seal("owner", "test-secret", VALUE, custody);
    const two = await seal("owner", "test-secret", VALUE, custody);
    for (const field of ["salt", "iv", "wrapIv", "wrappedKey", "ciphertext"] as const) {
      expect(one[field]).not.toBe(two[field]);
    }
  });

  it("re-wraps a record under a new key without changing its ciphertext", async () => {
    const custody = testCustody();
    const record = await seal("owner", "test-secret", VALUE, custody);
    const k2 = await custody.rotate("k1");
    const moved = await rewrap(record, k2, custody);
    expect(moved.keyId).toBe("k2");
    expect(moved.ciphertext).toBe(record.ciphertext);
    expect(moved.salt).not.toBe(record.salt);
    expect(await openSealed(moved, custody)).toBe(VALUE);
    // Without k1, only the re-wrapped record opens.
    custody.keys.delete("k1");
    expect(await openSealed(moved, custody)).toBe(VALUE);
    await expect(openSealed(record, custody)).rejects.toThrow();
  });
});

describe("rotation in the cell", () => {
  it("re-wraps every secret under k2, and a read between batches still decrypts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const custody = testCustody();
    let interleaved: string[] = [];
    const cell: SecretsCell = new SecretsCell(
      { storage: new FakeCelldStorage() },
      {},
      {
        custody,
        version: "v0.0.0-test",
        rotationBatch: 1,
        afterRotationBatch: async () => {
          if (interleaved.length > 0) return;
          // After the first batch: one record is under k2, the others still under k1.
          const store = await cell.storeForTests();
          const keyIds = (await store.rawRecords()).map((row) => row.key_id);
          interleaved = keyIds;
          for (const name of ["alpha", "beta", "gamma"]) {
            await store.allowlist("owner", name, "research", "add");
            await store.grant("owner", name, "research");
          }
          for (const name of ["alpha", "beta", "gamma"]) {
            expect(await store.get("owner", "research", name)).toBe(`${name}-value-0001`);
          }
        },
      },
    );
    cells.push(cell);
    for (const name of ["alpha", "beta", "gamma"]) {
      const added = await cell.add({ person: "owner", name, value: `${name}-value-0001` });
      expect(added).toEqual({ ok: true, value: { keyId: "k1", replaced: false } });
    }
    const rotated = await cell.rotate();
    expect(rotated).toEqual({
      ok: true,
      value: { from: "k1", keyId: "k2", rewrapped: 3, remaining: 0 },
    });
    expect(interleaved.sort()).toEqual(["k1", "k1", "k2"]);
    const store = await cell.storeForTests();
    expect((await store.rawRecords()).map((row) => row.key_id)).toEqual(["k2", "k2", "k2"]);
    // Every secret decrypts under k2 alone.
    custody.keys.delete("k1");
    for (const name of ["alpha", "beta", "gamma"]) {
      expect(await store.get("owner", "research", name)).toBe(`${name}-value-0001`);
    }
    const events = log.mock.calls.map((call) => JSON.parse(String(call[0])) as { event: string });
    expect(events.filter((event) => event.event === "secrets.rotated")).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("value-0001");
  });
});
