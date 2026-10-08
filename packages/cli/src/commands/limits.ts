// `secbot limits show | set <person> <usd> | developer <usd> | zone <IANA>`: the owner's monthly
// limits, with the operator key. A person's limit is that person cell's own; the developer budget
// and the household time zone are household settings. Each change applies from the next call (the
// time zone from the next month).

import { DEVELOPER_BUDGET } from "../budget-names.ts";
import type { OperatorClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";
import { money2 } from "../text.ts";
import type { HouseholdCost } from "./cost.ts";

const USAGE =
  "usage: secbot limits show | secbot limits set <person> <usd> | secbot limits developer <usd> | secbot limits zone <IANA time zone>";

/** A dollar amount above 0 with at most two decimals, as typed (`40`, `40.5`, `$40.00`). */
export function amountOf(typed: string | undefined): number {
  const match = /^\$?(\d{1,5})(\.\d{1,2})?$/.exec(typed ?? "");
  const value = match === null ? Number.NaN : Number(`${match[1]}${match[2] ?? ""}`);
  if (!(value > 0)) {
    throw new CliError("a limit is a dollar amount above 0, for example 40 or 40.50", 2);
  }
  return value;
}

export async function limits(
  client: () => Promise<OperatorClient>,
  io: Io,
  sub: string | undefined,
  args: readonly (string | undefined)[],
): Promise<number> {
  const [first, second] = args;
  if (sub === "show" && first === undefined) {
    const view = await (await client()).request<HouseholdCost>("GET", "/ops/cost");
    for (const person of view.persons) {
      io.stdout(`${person.person.padEnd(17)}${money2(person.limitUsd).padStart(10)}  a month\n`);
    }
    io.stdout(
      `${DEVELOPER_BUDGET.padEnd(17)}${money2(view.developer.limitUsd).padStart(10)}  a month\n`,
    );
    io.stdout(`time zone ${view.timeZone}\n`);
    return 0;
  }
  if (sub === "set" && first !== undefined && second !== undefined) {
    const usd = amountOf(second);
    const answer = await (await client()).request<{ person: string; limitUsd: number }>(
      "PUT",
      `/ops/limits?cell=${encodeURIComponent(first)}`,
      { limitUsd: usd },
    );
    io.stdout(`${first}'s monthly limit is now ${money2(answer.limitUsd)} from the next call\n`);
    return 0;
  }
  if (sub === DEVELOPER_BUDGET && first !== undefined && second === undefined) {
    const usd = amountOf(first);
    const answer = await (await client()).request<{ developerLimitUsd: number }>(
      "PUT",
      "/ops/limits?budget=developer",
      { limitUsd: usd },
    );
    io.stdout(
      `the developer budget is now ${money2(answer.developerLimitUsd)} from the next call\n`,
    );
    return 0;
  }
  if (sub === "zone" && first !== undefined && second === undefined) {
    const answer = await (await client()).request<{ timeZone: string }>("PUT", "/ops/time-zone", {
      timeZone: first,
    });
    io.stdout(`the household time zone is now ${answer.timeZone} from the next month\n`);
    return 0;
  }
  throw new CliError(USAGE, 2);
}
