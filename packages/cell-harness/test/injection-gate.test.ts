// The corpus gate (AC-28) on the stand-in: every case of the held-out injection corpus goes
// through the real check (chunking, the content question, the threshold) and the real decision
// model client against the stub decisions route, which the stand-in answers. The miss rate and
// the false-positive rate are recorded overall and per group, and the miss rate must stay at or
// under the release maximum. With SECBOT_EVIDENCE_DIR set, the rates are written there.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkContent } from "../src/content-check.ts";
import { createDecisionModel } from "../src/decision-model.ts";
import {
  type CorpusResult,
  falsePositiveRate,
  INJECTION_CORPUS,
  missRate,
} from "../src/injection-corpus.ts";
import { INJECTION_MAX_MISS_RATE } from "../src/release-defaults.ts";
import { standInAnswer } from "./injection-stand-in.ts";
import { type StubOpenRouter, startStubOpenRouter } from "./stub-openrouter.ts";

const KEY = "decisions-test-key-0000"; // gitleaks:allow (fake test key)

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
  stub.decide = standInAnswer;
});
afterAll(async () => {
  await stub.close();
});

describe("the injection corpus gate on the stand-in (AC-28)", () => {
  it("records the miss and false-positive rates and keeps the miss rate under the maximum", async () => {
    const model = createDecisionModel("jev", { apiKey: KEY, baseUrl: stub.origin });
    const results: (CorpusResult & { readonly chunks: number })[] = [];
    for (const each of INJECTION_CORPUS) {
      const verdict = await checkContent(model, {
        kind: each.kind,
        tool: "corpus",
        text: each.text,
      });
      // The stand-in never fails: a timeout or an error here would be a pipeline fault.
      expect(["clean", "hit"]).toContain(verdict.outcome);
      results.push({
        name: each.name,
        group: each.group,
        label: each.label,
        outcome: verdict.outcome === "clean" ? "clean" : "stopped",
        chunks: verdict.chunks,
      });
    }
    const misses = missRate(results);
    const falsePositives = falsePositiveRate(results);
    const evidence = {
      at: new Date().toISOString(),
      model: "stand-in (fixed rules, test/injection-stand-in.ts) on the stub decisions route",
      note: "The stand-in proves chunking, the question, and the threshold, not detection; its rules were written from the question's criteria, by the same author as the corpus. The live score on the decision model is taken on the test cell.",
      threshold: INJECTION_MAX_MISS_RATE,
      cases: results.length,
      missRate: misses,
      falsePositiveRate: falsePositives,
      missed: results
        .filter((result) => result.label === "injection" && result.outcome === "clean")
        .map((result) => result.name),
      falselyStopped: results
        .filter((result) => result.label === "clean" && result.outcome === "stopped")
        .map((result) => result.name),
      longTailChunks: results
        .filter((result) => result.group === "long-tail")
        .map((result) => result.chunks),
    };
    const dir = process.env.SECBOT_EVIDENCE_DIR;
    if (dir !== undefined && dir !== "") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "ac-28-injection-corpus.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
    // Every long text needed more than one chunk, so its order was checked past the first.
    for (const chunks of evidence.longTailChunks) expect(chunks).toBeGreaterThan(1);
    expect(misses.overall).toBeLessThanOrEqual(INJECTION_MAX_MISS_RATE);
  });
});
