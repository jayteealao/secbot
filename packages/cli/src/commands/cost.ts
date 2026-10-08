// `secbot cost`: the month's spend of the device's own person, by layer and by role. The owner, with
// the operator key: `--person <name>` for one person, `--owner` for the household table (every
// person, the developer budget, and when each shadow cell has a week of logs to switch on).

import { DEVELOPER_BUDGET } from "../budget-names.ts";
import type { CellClient, OperatorClient } from "../client.ts";
import type { Io } from "../io.ts";
import { dayTime, money2, monthName, RULE, rightAligned } from "../text.ts";
import { meter } from "./usage.ts";

/** `GET /v1/cells/<p>/cost` and `GET /ops/cost?cell=<p>`. */
export interface CostView {
  readonly person: string;
  readonly month: string;
  readonly timeZone: string;
  readonly resetsAt: number;
  readonly mode: string;
  readonly modeSince: number | null;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly byLayer: {
    readonly agent: number;
    readonly decision: number;
    readonly reviewer: number;
  };
  readonly byRole: Readonly<Record<string, number>>;
  /** Set when the answer came from the household board (a cell another fleet serves). */
  readonly asOf?: number;
}

interface HouseholdRow {
  readonly person: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly mode: string;
  readonly modeSince: number | null;
}

/** `GET /ops/cost`. */
export interface HouseholdCost {
  readonly month: string;
  readonly timeZone: string;
  readonly totalUsd: number;
  readonly persons: readonly HouseholdRow[];
  readonly developer: {
    readonly spentUsd: number;
    readonly limitUsd: number;
    readonly percent: number;
  };
}

const DAY_MS = 86_400_000;
/** A cell's guard runs in shadow at least this long before the owner switches it to enforce. */
export const SHADOW_DAYS = 7;

/** The person view: header, the 20-cell meter, then BY LAYER beside BY ROLE. */
export function costLines(view: CostView, operator: boolean): string[] {
  const who = operator ? `${view.person} (operator key)` : view.person;
  const when =
    view.asOf !== undefined && view.resetsAt === 0
      ? `as of ${dayTime(view.asOf, view.timeZone)}`
      : `resets ${dayTime(view.resetsAt, view.timeZone)}`;
  const right = `[ ${view.mode} ]  ${when}`;
  const lines = [
    // Right-aligned at column 78, the rule's right edge, as the activity and held-call headers.
    rightAligned(`COST  ${who}  ${monthName(view.month)}`, right),
    RULE,
    `[ month: ${money2(view.spentUsd)} / ${money2(view.limitUsd)} ] ${meter(view.percent, 20)} ${view.percent}%`,
    "",
  ];
  const layers: [string, number][] = [
    ["agent model", view.byLayer.agent],
    ["reviewer", view.byLayer.reviewer],
    ["decision model", view.byLayer.decision],
  ];
  const roles = Object.entries(view.byRole)
    .filter(([, spent]) => spent > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const left = (label: string, usd: number) => `${label}${money2(usd).padStart(24 - label.length)}`;
  const roleCell = (label: string, usd: number) =>
    `${label}${money2(usd).padStart(Math.max(label.length + 1, 19) - label.length)}`;
  lines.push(`${"BY LAYER".padEnd(29)}BY ROLE`);
  for (let index = 0; index < Math.max(layers.length, roles.length); index++) {
    const layer = layers[index];
    const role = roles[index];
    const start = layer === undefined ? "" : left(layer[0], layer[1]);
    lines.push(
      role === undefined ? start : `${start.padEnd(29)}${roleCell(role[0], role[1])}`.trimEnd(),
    );
  }
  return lines;
}

/** Days of shadow logs a cell has: whole days since it went into shadow mode. */
const shadowDays = (since: number | null, now: number) =>
  since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY_MS));

const row = (person: string, spent: string, limit: string, used: string, mode: string) =>
  `${person.padEnd(17)}${spent.padStart(6)}${limit.padStart(11)}${used.padStart(8)}   ${mode}`.trimEnd();

/** The household table for the owner. */
export function householdLines(view: HouseholdCost, now: number): string[] {
  const lines = [
    rightAligned(
      `COST  household  ${monthName(view.month)}`,
      `[ total: ${money2(view.totalUsd)} ]`,
    ),
    RULE,
    row("PERSON", "SPENT", "LIMIT", "USED", "MODE"),
  ];
  let switchFrom: number | undefined;
  for (const person of view.persons) {
    let mode = person.mode;
    if (person.mode === "shadow") {
      const days = shadowDays(person.modeSince, now);
      mode = `shadow (${days} d of logs)`;
      // The day every shadow cell has a week of logs: the owner's earliest switch to enforce.
      const ready = (person.modeSince ?? now) + SHADOW_DAYS * DAY_MS;
      switchFrom = Math.max(switchFrom ?? 0, ready);
    }
    lines.push(
      row(
        person.person,
        money2(person.spentUsd),
        money2(person.limitUsd),
        `${person.percent}%`,
        mode,
      ),
    );
  }
  lines.push(
    row(
      DEVELOPER_BUDGET,
      money2(view.developer.spentUsd),
      money2(view.developer.limitUsd),
      `${view.developer.percent}%`,
      "budget",
    ),
  );
  if (switchFrom !== undefined) {
    const day = dayTime(switchFrom, view.timeZone).replace(/ \d\d:\d\d$/, "");
    lines.push(`switch to enforce from ${day}: secbot mode set <person> enforce`);
  }
  return lines;
}

export async function costOwn(client: CellClient, io: Io): Promise<number> {
  const view = await client.request<CostView>("GET", "/cost");
  io.stdout(`${costLines(view, false).join("\n")}\n`);
  return 0;
}

export async function costOf(client: OperatorClient, io: Io, person: string): Promise<number> {
  const view = await client.request<CostView>(
    "GET",
    `/ops/cost?cell=${encodeURIComponent(person)}`,
  );
  io.stdout(`${costLines(view, true).join("\n")}\n`);
  return 0;
}

export async function costHousehold(
  client: OperatorClient,
  io: Io,
  now: () => number = Date.now,
): Promise<number> {
  const view = await client.request<HouseholdCost>("GET", "/ops/cost");
  io.stdout(`${householdLines(view, now()).join("\n")}\n`);
  return 0;
}
