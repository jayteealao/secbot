// node:test tests for the monthly cost arithmetic (scripts/measure-cost.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogCost, fixedCost, loadCatalog, loggedCost, modelCalls } from "./measure-cost.mjs";

const assumptions = {
  leadModel: "lead/model",
  specialistModel: "specialist/model",
  persons: [
    {
      name: "owner",
      leadTurnsPerDay: 10,
      handoffsPerDay: 2,
      specialistTurnsPerHandoff: 2,
      leadInputTokens: 10_000,
      leadCacheReadShare: 0.5,
      leadOutputTokens: 1_000,
      specialistInputTokens: 2_000,
      specialistOutputTokens: 500,
    },
  ],
  fixedMonthlyUsd: { vps: 6, r2: 0.5, betterstack: 0 },
};
const prices = new Map([
  ["lead/model", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  ["specialist/model", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
]);

test("the catalog estimate prices each turn with the arithmetic shown", () => {
  const { lines, monthly } = catalogCost(assumptions, prices);
  // lead turn: 5000 x 4/M + 5000 x 0.2/M + 1000 x 20/M = 0.02 + 0.001 + 0.02 = 0.041
  // specialist turn: 2000 x 1/M + 500 x 5/M = 0.0045; a day: 10 x 0.041 + 2 x 2 x 0.0045 = 0.428
  assert.ok(Math.abs((monthly.get("owner") ?? 0) - 12.84) < 1e-9);
  assert.equal(lines.at(-1), "owner: a month = $0.43 x 30 = $12.84");
  assert.throws(
    () => catalogCost({ ...assumptions, leadModel: "nope" }, prices),
    /no catalog price for nope/,
  );
});

test("the logged estimate sums model.call lines per cell, skips failed attempts, and scales to a month", () => {
  const log = [
    'Oct 07 celld[1]: {"event":"model.call","cell":"owner","role":"lead","model":"m","served_model":"m","cost_usd":0.5,"stop_reason":"stop"}',
    '{"event":"model.call","cell":"owner","role":"lead","model":"m","cost_usd":9,"stop_reason":"error"}',
    '{"event":"heartbeat.ping","cell":"owner"}',
    '{"event":"model.call","cell":"second","role":"health","model":"h","cost_usd":0.1,"stop_reason":"stop"}',
    "not json",
  ].join("\n");
  const calls = modelCalls(log);
  assert.equal(calls.length, 3);
  const { monthly, lines } = loggedCost(calls, 2);
  assert.equal(monthly.get("owner"), 7.5);
  assert.ok(Math.abs((monthly.get("second") ?? 0) - 1.5) < 1e-9);
  assert.ok(lines.includes("owner: $0.50 over 2 days / 2 x 30 = $7.50 a month"));
});

test("fixed cost is split over the persons", () => {
  const { perPerson, lines } = fixedCost({ ...assumptions, persons: [{}, {}] });
  assert.equal(perPerson, 3.25);
  assert.deepEqual(lines, [
    "fixed: vps $6.00 + r2 $0.50 + betterstack $0.00 = $6.50 a month",
    "fixed per person: $6.50 / 2 = $3.25",
  ]);
});

test("the installed catalog has prices for the release default models", async () => {
  const catalog = await loadCatalog();
  assert.ok(catalog.get("anthropic/claude-opus-5.5"));
  assert.ok(catalog.get("anthropic/claude-haiku-4.5"));
});
