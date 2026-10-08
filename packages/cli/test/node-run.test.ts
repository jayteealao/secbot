/**
 * Runs the CLI the way the owner does (`mise run cli` is `node packages/cli/src/main.ts`): plain
 * Node with its built-in type stripping and no transpiler. Every source file must use erasable
 * TypeScript only, or Node refuses to load it.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("secbot under plain Node", () => {
  it("loads and runs a command without a transpiler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secbot-node-"));
    try {
      const { SECBOT_CELL_URL: _url, ...env } = process.env;
      const result = spawnSync(process.execPath, [main, "missed"], {
        env: { ...env, SECBOT_CONFIG_DIR: dir },
        encoding: "utf8",
      });
      expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
      expect(result.stderr).toContain("no cell address");
      expect(result.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
