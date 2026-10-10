// The worker entry modules' named exports. The cell runtime loads every named export of a Worker's
// main module as an entry point and refuses the whole Worker when one is not a class, a function,
// or a handler object: a string constant in the production entry (src/index.ts) stopped the
// production fleet from starting, and one in the test-cell entry made the test cell keep serving
// the previous version. Each entry exports only its handler and its Durable Object classes; cell
// names and helpers live in other modules.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as conformanceEntry from "../src/conformance-entry.ts";
import * as entry from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The Durable Object classes a wrangler config binds (JSONC with whole-line `//` comments). */
function boundClasses(file: string): string[] {
  const text = readFileSync(join(here, "..", file), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const config = JSON.parse(text) as {
    durable_objects: { bindings: { class_name: string }[] };
  };
  return config.durable_objects.bindings.map((binding) => binding.class_name);
}

/** The exports the runtime would refuse: anything but a class, a function, or a handler object. */
function refused(module: Record<string, unknown>): string[] {
  return Object.entries(module)
    .filter(([, value]) => {
      if (typeof value === "function") return false;
      if (typeof value !== "object" || value === null) return true;
      // A handler object: every member is a handler function.
      return Object.values(value).some((member) => typeof member !== "function");
    })
    .map(([name]) => name);
}

/** Exports of a primitive type: the runtime refuses these before anything else. */
const primitives = (module: Record<string, unknown>) =>
  Object.entries(module)
    .filter(([, value]) =>
      ["string", "number", "boolean", "bigint", "symbol"].includes(typeof value),
    )
    .map(([name]) => name);

describe.each([
  { name: "the production worker module", module: entry, config: "wrangler.jsonc" },
  {
    name: "the test-cell worker module",
    module: conformanceEntry,
    config: "wrangler.conformance.jsonc",
  },
])("$name", ({ module, config }) => {
  const exported = module as unknown as Record<string, unknown>;

  it("exports no string, number, or boolean", () => {
    expect(primitives(exported)).toEqual([]);
  });

  it("exports only classes, functions, or handler objects", () => {
    expect(refused(exported)).toEqual([]);
  });

  it("exports a default fetch handler", () => {
    const handler = exported.default as { fetch?: unknown } | undefined;
    expect(typeof handler?.fetch).toBe("function");
  });

  it("exports each Durable Object class its config binds", () => {
    for (const name of boundClasses(config)) expect(typeof exported[name], name).toBe("function");
  });
});

describe("the production worker module", () => {
  it("exports only the default handler and the classes wrangler.jsonc binds", () => {
    const expected = ["default", ...boundClasses("wrangler.jsonc")].sort();
    expect(Object.keys(entry).sort()).toEqual(expected);
  });
});
