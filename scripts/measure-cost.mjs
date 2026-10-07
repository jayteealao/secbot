#!/usr/bin/env node
// The monthly cost estimate per person (AC-33), with every line of arithmetic.
//
//   node scripts/measure-cost.mjs --assumptions <file.json> [--log <cell log> --log-days N] [--out <file.md>]
//
// With --log, model cost is the sum of the `model.call` lines' cost_usd (the cell's own log of
// what OpenRouter charged, packages/cell-harness/src/telemetry.ts), per person cell, scaled from
// the days the log covers to a month. Without it, model cost is a catalog estimate: the usage
// assumptions priced with pi-ai's installed OpenRouter catalog (USD per million tokens). Fixed
// cost comes from the assumptions file. Node standard library only.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAYS_PER_MONTH = 30;

const usd = (value) => `$${value.toFixed(2)}`;
// Per-turn and per-day amounts are fractions of a cent apart, so the lines that multiply them
// print five decimals; otherwise the shown arithmetic would not add up to the shown result.
const usdFine = (value) => `$${value.toFixed(5)}`;

/** pi-ai's installed OpenRouter catalog: model id to { input, output, cacheRead, cacheWrite }. */
export async function loadCatalog() {
  // pi-ai exports no main, so the catalog is read by path from the workspace link of the harness
  // package (source: node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json).
  const file = join(
    root,
    "packages",
    "cell-harness",
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "data",
    "openrouter.json",
  );
  const data = JSON.parse(await readFile(file, "utf8"));
  const prices = new Map();
  for (const group of Object.values(data)) {
    const models = Array.isArray(group) ? group : Object.values(group?.models ?? group ?? {});
    for (const model of models) {
      if (typeof model?.id === "string" && model.cost) prices.set(model.id, model.cost);
    }
  }
  return prices;
}

/** The `model.call` objects in a log, whatever prefix each line carries. Pure. */
export function modelCalls(text) {
  const calls = [];
  for (const line of text.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0 || !line.includes('"model.call"')) continue;
    try {
      const value = JSON.parse(line.slice(start));
      if (value.event === "model.call") calls.push(value);
    } catch {
      // Not a JSON line.
    }
  }
  return calls;
}

/** Monthly model cost per person cell from logged calls over `days`. Pure. */
export function loggedCost(calls, days) {
  const lines = [];
  const perCell = new Map();
  for (const call of calls) {
    if (call.stop_reason === "error") continue;
    const cost = Number(call.cost_usd ?? 0);
    const cell = String(call.cell ?? "unknown");
    const byModel = perCell.get(cell) ?? new Map();
    const key = `${call.role} ${call.served_model ?? call.model}`;
    const entry = byModel.get(key) ?? { calls: 0, cost: 0 };
    entry.calls++;
    entry.cost += cost;
    byModel.set(key, entry);
    perCell.set(cell, byModel);
  }
  const monthly = new Map();
  for (const [cell, byModel] of perCell) {
    let total = 0;
    for (const [key, entry] of byModel) {
      lines.push(`${cell}: ${key}: ${entry.calls} calls, ${usd(entry.cost)}`);
      total += entry.cost;
    }
    const month = (total / days) * DAYS_PER_MONTH;
    lines.push(
      `${cell}: ${usd(total)} over ${days} days / ${days} x ${DAYS_PER_MONTH} = ${usd(month)} a month`,
    );
    monthly.set(cell, month);
  }
  return { lines, monthly };
}

const tokenCost = (tokens, pricePerMillion) => (tokens * pricePerMillion) / 1_000_000;

/** Monthly model cost per person from the usage assumptions and catalog prices. Pure. */
export function catalogCost(assumptions, prices) {
  const lines = [];
  const monthly = new Map();
  const priceOf = (model) => {
    const price = prices.get(model);
    if (price === undefined) throw new Error(`no catalog price for ${model}`);
    return price;
  };
  for (const person of assumptions.persons ?? []) {
    const lead = priceOf(assumptions.leadModel);
    const specialist = priceOf(assumptions.specialistModel);
    const cached = person.leadInputTokens * person.leadCacheReadShare;
    const fresh = person.leadInputTokens - cached;
    const leadTurn =
      tokenCost(fresh, lead.input) +
      tokenCost(cached, lead.cacheRead) +
      tokenCost(person.leadOutputTokens, lead.output);
    lines.push(
      `${person.name}: lead turn = ${fresh} x $${lead.input}/M + ${cached} x $${lead.cacheRead}/M (cache read) + ${person.leadOutputTokens} x $${lead.output}/M = ${usdFine(leadTurn)}`,
    );
    const specialistTurn =
      tokenCost(person.specialistInputTokens, specialist.input) +
      tokenCost(person.specialistOutputTokens, specialist.output);
    lines.push(
      `${person.name}: specialist turn = ${person.specialistInputTokens} x $${specialist.input}/M + ${person.specialistOutputTokens} x $${specialist.output}/M = ${usdFine(specialistTurn)}`,
    );
    const daily =
      person.leadTurnsPerDay * leadTurn +
      person.handoffsPerDay * person.specialistTurnsPerHandoff * specialistTurn;
    lines.push(
      `${person.name}: a day = ${person.leadTurnsPerDay} x ${usdFine(leadTurn)} + ${person.handoffsPerDay} x ${person.specialistTurnsPerHandoff} x ${usdFine(specialistTurn)} = ${usdFine(daily)}`,
    );
    const month = daily * DAYS_PER_MONTH;
    lines.push(`${person.name}: a month = ${usdFine(daily)} x ${DAYS_PER_MONTH} = ${usd(month)}`);
    monthly.set(person.name, month);
  }
  return { lines, monthly };
}

/** Fixed cost per person: the sum of the fixed items, split over the persons. Pure. */
export function fixedCost(assumptions) {
  const items = Object.entries(assumptions.fixedMonthlyUsd ?? {});
  const total = items.reduce((sum, [, value]) => sum + Number(value), 0);
  const persons = Math.max(1, (assumptions.persons ?? []).length);
  const lines = [
    `fixed: ${items.map(([name, value]) => `${name} ${usd(Number(value))}`).join(" + ")} = ${usd(total)} a month`,
    `fixed per person: ${usd(total)} / ${persons} = ${usd(total / persons)}`,
  ];
  return { lines, perPerson: total / persons };
}

async function main() {
  const { values } = parseArgs({
    options: {
      assumptions: { type: "string" },
      log: { type: "string" },
      "log-days": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.assumptions) throw new Error("measure:cost needs --assumptions <file.json>");
  const assumptions = JSON.parse(await readFile(values.assumptions, "utf8"));
  const model = values.log
    ? loggedCost(modelCalls(await readFile(values.log, "utf8")), Number(values["log-days"] ?? 1))
    : catalogCost(assumptions, await loadCatalog());
  const fixed = fixedCost(assumptions);
  const kind = values.log ? "logged model.call cost" : "catalog estimate (no live calls yet)";
  const lines = [`cost: ${kind}`, ...model.lines, ...fixed.lines];
  for (const [person, month] of model.monthly) {
    lines.push(
      `cost ${person}: model ${usd(month)} + fixed ${usd(fixed.perPerson)} = ${usd(month + fixed.perPerson)} a month`,
    );
  }
  for (const line of lines) console.log(line);
  if (values.out) {
    await writeFile(
      values.out,
      `# Monthly cost per person\n\nMethod: ${kind}.\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`measure:cost: ${error.message}`);
    process.exit(1);
  });
}
