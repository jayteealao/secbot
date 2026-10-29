// The stop module sits low in the harness: the job board, the lead's texts, and the shared-job
// relay all read its lock text, so it imports only the cell's parts and its documents. Any other
// local import would close an import cycle through those modules.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("stop module imports", () => {
  it("imports only the cell's parts and documents from this package", async () => {
    const text = await readFile(join(src, "stop.ts"), "utf8");
    const local = [...text.matchAll(/from "(\.\/[^"]+)"/g)].map((match) => match[1]).sort();
    expect(local).toEqual(["./cell-parts.ts", "./docs.ts"]);
  });
});
