// node --test scripts/ — the license gate's collection and verdict logic (scripts/check-licenses.mjs).
// The installed packages are a fixture virtual store under a temp dir, laid out the way pnpm does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { collectInstalled, findFailures, isAllowed, licenseOf } from "./check-licenses.mjs";

// <store>/<entry>/node_modules/<name> holds the package; `links` are its dependencies, which pnpm
// links in from other entries.
function install(store, entry, manifest, links = []) {
  const modules = join(store, entry, "node_modules");
  const dir = join(modules, manifest.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const link of links) {
    const target = join(store, link.entry, "node_modules", link.name);
    mkdirSync(dirname(join(modules, link.name)), { recursive: true });
    symlinkSync(target, join(modules, link.name), "junction");
  }
}

function withStore(run) {
  const store = mkdtempSync(join(tmpdir(), "secbot-licenses-"));
  try {
    return run(store);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}

test("reads the license of every installed package, transitive ones and scoped names included", () => {
  withStore((store) => {
    install(store, "left-pad@1.0.0", { name: "left-pad", version: "1.0.0", license: "MIT" });
    install(
      store,
      "@scope+tool@2.0.0",
      { name: "@scope/tool", version: "2.0.0", license: "Apache-2.0" },
      [{ entry: "left-pad@1.0.0", name: "left-pad" }],
    );
    mkdirSync(join(store, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(store, "lock.yaml"), "lockfileVersion: 9\n");
    const found = collectInstalled(store);
    assert.deepEqual(found.map((pkg) => `${pkg.name}@${pkg.version} ${pkg.license}`).sort(), [
      "@scope/tool@2.0.0 Apache-2.0",
      "left-pad@1.0.0 MIT",
    ]);
  });
});

test("a git-hosted dependency is read from its entry like any other", () => {
  withStore((store) => {
    install(store, "@earendil-works+pi-durable@_39a2d184757a80d838824f8a34b421a0", {
      name: "@earendil-works/pi-durable",
      version: "1.0.3",
      license: "MIT",
    });
    assert.deepEqual(collectInstalled(store), [
      { name: "@earendil-works/pi-durable", version: "1.0.3", license: "MIT" },
    ]);
  });
});

test("a missing store says to install first", () => {
  assert.throws(
    () => collectInstalled(join(tmpdir(), "secbot-licenses-missing")),
    /run pnpm install first/,
  );
});

test("licenseOf reads license, a { type } object, the legacy licenses array, or Unknown", () => {
  assert.equal(licenseOf({ license: "MIT" }), "MIT");
  assert.equal(licenseOf({ license: { type: "ISC" } }), "ISC");
  assert.equal(licenseOf({ licenses: [{ type: "MIT" }] }), "MIT");
  assert.equal(
    licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "(MIT OR Apache-2.0)",
  );
  assert.equal(licenseOf({ name: "x" }), "Unknown");
  assert.equal(licenseOf({ license: "  " }), "Unknown");
});

test("the allowlist, OR, AND, WITH, and unknown licenses", () => {
  assert.equal(isAllowed("MIT"), true);
  assert.equal(isAllowed("MIT OR GPL-3.0-only"), true);
  assert.equal(isAllowed("(MIT OR Apache-2.0)"), true);
  assert.equal(isAllowed("MIT AND GPL-3.0-only"), false);
  assert.equal(isAllowed("GPL-3.0-only"), false);
  assert.equal(isAllowed("AGPL-3.0-or-later"), false);
  assert.equal(isAllowed("Apache-2.0 WITH LLVM-exception"), false);
  assert.equal(isAllowed("Unknown"), false);
});

test("failures list name, versions, and license once per package, sorted", () => {
  const failures = findFailures([
    { name: "z-pkg", version: "1.0.0", license: "GPL-3.0-only" },
    { name: "a-pkg", version: "2.0.0", license: "Unknown" },
    { name: "a-pkg", version: "1.0.0", license: "Unknown" },
    { name: "fine", version: "1.0.0", license: "MIT" },
  ]);
  assert.deepEqual(failures, ["a-pkg@1.0.0,2.0.0: Unknown", "z-pkg@1.0.0: GPL-3.0-only"]);
});
