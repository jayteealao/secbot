#!/usr/bin/env node
// Builds the server bundle into dist/ at the repo root (the release tars dist/).
//   dist/worker/       person-cell worker with the harness (index.js, wrangler.jsonc)
//   dist/conformance/  test-cell worker with the in-cell conformance run
//   dist/vps/          the VPS release tool, so a staged bundle carries the tool it was tested with
//   dist/manifest.json version, contract step, and SHA-256 of every file
// Usage: node scripts/build-bundle.mjs [--version vX.Y.Z]
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

/** Raise when a release changes stored data so that an older bundle can no longer read it.
 * Step 2: the PersonCell Durable Object class and its migration (the per-person harness).
 * Step 3: the HouseholdCell class (shared household lists) and, on the test cell only, the
 * DurabilityLabCell class, with their migrations; person cells now store routine timers. */
export const CONTRACT_STEP = 3;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const worker = join(root, "packages", "cell-worker");

const { values } = parseArgs({ options: { version: { type: "string" } } });
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
const version = values.version ?? tag ?? "0.0.0-dev";
if (!/^(v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?|0\.0\.0-dev)$/.test(version)) {
  console.error(`build: refusing version "${version}"; expected vX.Y.Z`);
  process.exit(1);
}

const bundle = (entry, outdir) =>
  build({
    entryPoints: [join(worker, "src", entry)],
    outfile: join(outdir, "index.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
    define: { __SECBOT_VERSION__: JSON.stringify(version) },
    legalComments: "inline",
    logLevel: "warning",
  });

const listFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

await rm(dist, { recursive: true, force: true });
await bundle("index.ts", join(dist, "worker"));
await cp(join(worker, "wrangler.jsonc"), join(dist, "worker", "wrangler.jsonc"));
await bundle("conformance-entry.ts", join(dist, "conformance"));
await cp(join(worker, "wrangler.conformance.jsonc"), join(dist, "conformance", "wrangler.jsonc"));
await mkdir(join(dist, "vps"), { recursive: true });
await cp(
  join(root, "infra", "ansible", "roles", "deploy_users", "files", "secbot-release"),
  join(dist, "vps", "secbot-release"),
);

const files = [];
for (const file of await listFiles(dist)) {
  const bytes = await readFile(file);
  files.push({
    path: relative(dist, file).split("\\").join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: (await stat(file)).size,
  });
}
const manifest = { version, contractStep: CONTRACT_STEP, files };
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `build: dist/ ready for ${version} (${files.length} files, contract step ${CONTRACT_STEP})`,
);
