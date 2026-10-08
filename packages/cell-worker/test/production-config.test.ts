// The production worker (wrangler.jsonc, entry src/index.ts) is not the one the test cell runs, so
// its config is checked here: every Durable Object class it binds or migrates is a class the
// entry exports, the migration chain introduces each class once with unique tags, and every
// runtime var the VPS release tool fills is declared empty.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

interface WorkerConfig {
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  vars: Record<string, string>;
}

/** JSONC with whole-line `//` comments, as the repo writes it. */
function readConfig(file: string): WorkerConfig {
  const text = readFileSync(join(here, "..", file), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text) as WorkerConfig;
}

/** The names the release tool requires and the ones it fills when set. */
function releaseToolVars(): string[] {
  const tool = readFileSync(
    join(root, "infra", "ansible", "roles", "deploy_users", "files", "secbot-release"),
    "utf8",
  );
  const list = (name: string) =>
    (new RegExp(`^${name}="([^"]*)"`, "m").exec(tool)?.[1] ?? "").split(" ").filter(Boolean);
  return [
    ...list("RUNTIME_VARS"),
    ...list("OPTIONAL_RUNTIME_VARS"),
    "SECBOT_OPERATOR_KEY",
    "SECBOT_FLEET_CELLS",
    "SECBOT_HOUSEHOLD_URL",
  ];
}

describe("the production worker config", () => {
  const config = readConfig("wrangler.jsonc");
  const exported = entry as unknown as Record<string, unknown>;

  it("binds and migrates only classes the entry exports", () => {
    const bound = config.durable_objects.bindings.map((binding) => binding.class_name);
    const migrated = config.migrations.flatMap((step) => [
      ...(step.new_sqlite_classes ?? []),
      ...(step.new_classes ?? []),
    ]);
    for (const name of [...bound, ...migrated]) {
      expect(typeof exported[name], `${name} is exported by src/index.ts`).toBe("function");
    }
    // Every bound class has a migration that creates it.
    for (const name of bound) expect(migrated).toContain(name);
  });

  it("has a migration chain with unique tags that creates each class once", () => {
    const tags = config.migrations.map((step) => step.tag);
    expect(new Set(tags).size).toBe(tags.length);
    const created = config.migrations.flatMap((step) => [
      ...(step.new_sqlite_classes ?? []),
      ...(step.new_classes ?? []),
    ]);
    expect(new Set(created).size).toBe(created.length);
  });

  it("declares every runtime var the release tool fills, each empty", () => {
    const names = releaseToolVars();
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(config.vars[name], name).toBe("");
  });
});
