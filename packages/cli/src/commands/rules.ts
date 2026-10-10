// `secbot rules list | add | remove`: the person's own rules under the owner's rules. With
// `--owner --person <name>` the owner edits owner rules for that person with the operator key.
import type { CellClient, OperatorClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";
import {
  columns,
  dayTime,
  matchText,
  RULE,
  type Rule,
  ruleText,
  toolText,
  verdictText,
} from "../text.ts";

/** A person's guard routes, through the device key or (for the owner) the operator key. */
export interface GuardTarget {
  /** Set when the owner reads another person with the operator key. */
  readonly person: string | undefined;
  request<T>(
    method: string,
    route: "rules" | "activity",
    body?: unknown,
    query?: string,
  ): Promise<T>;
}

export function deviceTarget(client: CellClient): GuardTarget {
  return {
    person: undefined,
    request: (method, route, body, query = "") =>
      client.request(method, `/${route}${query === "" ? "" : `?${query}`}`, body),
  };
}

export function operatorTarget(client: OperatorClient, person: string): GuardTarget {
  return {
    person,
    request: (method, route, body, query = "") =>
      client.request(
        method,
        `/ops/${route}?cell=${encodeURIComponent(person)}${query === "" ? "" : `&${query}`}`,
        body,
      ),
  };
}

type RuleLists = { owner: Rule[]; person: Rule[]; timeZone?: string };

const STARTS = [0, 11, 30, 61];
const HEADER = "AGENT      TOOL               MATCH                          VERDICT";

function table(title: string, rules: readonly Rule[], timeZone: string): string[] {
  const lines = [title, RULE, HEADER];
  if (rules.length === 0) lines.push("none");
  for (const rule of rules) {
    lines.push(
      ...columns(
        [rule.agent, toolText(rule.tool), matchText(rule.match), verdictText(rule.verdict)],
        STARTS,
      ),
    );
    if (rule.source === "allow-always" && rule.addedAt !== undefined) {
      lines.push(`             added by allow always, ${dayTime(rule.addedAt, timeZone)}`);
    }
  }
  return lines;
}

export async function rulesList(target: GuardTarget, io: Io): Promise<number> {
  const rules = await target.request<RuleLists>("GET", "rules");
  const timeZone = rules.timeZone ?? "UTC";
  const yours =
    target.person === undefined ? "YOUR RULES" : `${target.person.toUpperCase()}'S RULES`;
  const lines = [
    ...table("OWNER RULES (you cannot loosen these)", rules.owner, timeZone),
    "",
    ...table(yours, rules.person, timeZone),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

const MATCH_OPTIONS = ["exact", "prefix", "email-domain", "web-domain", "regex"] as const;
const VERDICTS = ["permit", "ask-first", "prohibit"];

export type MatchOptions = Partial<Record<(typeof MATCH_OPTIONS)[number], string>>;

/** The one match option given, as `{kind, field, value}`; none gives undefined. */
export function matchOf(options: MatchOptions): Rule["match"] {
  const given = MATCH_OPTIONS.filter((kind) => options[kind] !== undefined);
  if (given.length > 1) throw new CliError("give at most one match option", 2);
  const kind = given[0];
  if (kind === undefined) return undefined;
  const raw = options[kind] ?? "";
  const equals = raw.indexOf("=");
  if (equals <= 0 || equals === raw.length - 1) {
    throw new CliError(`--${kind} takes <argument>=<value>, for example specialist=research`, 2);
  }
  return { kind, field: raw.slice(0, equals), value: raw.slice(equals + 1) };
}

const RULE_USAGE =
  "usage: secbot rules add <agent> <tool> <permit|ask-first|prohibit> [--exact|--prefix|--email-domain|--web-domain|--regex <argument>=<value>]";

export async function rulesAdd(
  target: GuardTarget,
  io: Io,
  args: readonly (string | undefined)[],
  options: MatchOptions,
): Promise<number> {
  const [agent, tool, verdict] = args;
  if (agent === undefined || tool === undefined || verdict === undefined) {
    throw new CliError(RULE_USAGE, 2);
  }
  if (!VERDICTS.includes(verdict))
    throw new CliError(`the verdict is one of ${VERDICTS.join(", ")}`, 2);
  const match = matchOf(options);
  const { rule } = await target.request<{ rule: Rule }>("POST", "rules", {
    agent,
    tool,
    verdict,
    ...(match === undefined ? {} : { match }),
  });
  io.stdout(`added: ${ruleText(rule)}\n`);
  return 0;
}

export async function rulesRemove(
  target: GuardTarget,
  io: Io,
  args: readonly (string | undefined)[],
  options: MatchOptions,
): Promise<number> {
  const [agent, tool] = args;
  if (agent === undefined || tool === undefined) {
    throw new CliError(
      "usage: secbot rules remove <agent> <tool> [the match option the rule was added with]",
      2,
    );
  }
  const match = matchOf(options);
  const { removed } = await target.request<{ removed: Rule }>("DELETE", "rules", {
    agent,
    tool,
    ...(match === undefined ? {} : { match }),
  });
  io.stdout(`removed: ${ruleText(removed)}\n`);
  return 0;
}
