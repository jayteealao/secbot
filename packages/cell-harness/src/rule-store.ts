/**
 * The rules of one person cell: the owner's rules (edited only with the operator key) and the
 * person's own rules. A person rule looser than an owner rule is refused when it is added, naming
 * the owner rule; at call time the strictest verdict wins anyway (rules.ts).
 *
 * Every add, remove, and refusal logs one `rules.changed` event with the match kind but never the
 * match value.
 */
import type { Context } from "@earendil-works/chord";
import type { Tx } from "@earendil-works/pi-durable";
import { type CellParts, logEvent, RefusedChange } from "./cell-parts.ts";
import { RosterDoc, RulesDoc } from "./docs.ts";
import { DEFAULT_PERSON_RULES, LEAD_ROLE, RELEASE_OWNER_RULES } from "./release-defaults.ts";
import {
  ALL_AGENTS,
  ANY_TOOL,
  checkPattern,
  looserThan,
  MATCH_KINDS,
  type MatchKind,
  matchText,
  normalizeMatchValue,
  PAY_GROUP,
  PAY_PREFIX,
  type Rule,
  type RuleInput,
  type RuleLevel,
  type RuleMatch,
  ruleText,
  toolText,
  VERDICTS,
  type Verdict,
} from "./rules.ts";

/** The most rules one level may hold. */
export const RULES_LIMIT = 200;
/** The longest match value. */
export const MATCH_VALUE_LIMIT = 500;

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A rule's owner, person, and tool name, without its id: how a removal names a rule. */
export type RuleKey = Pick<RuleInput, "agent" | "tool" | "match">;

/** No rule with the agent, tool, and match a removal named. */
export class RuleNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleNotFound";
  }
}

export interface RuleLists {
  readonly owner: readonly Rule[];
  readonly person: readonly Rule[];
}

/**
 * Adds each release owner rule the cell does not hold yet (by agent, tool, and match), so a cell
 * created under an older release gains a new release rule on its next open. A rule the owner
 * already added with the same agent, tool, and match stays as it is. Returns the added rules (plain
 * copies); the caller logs `rules.changed` for each after the commit.
 */
export async function topUpOwnerRules(tx: Tx, now: number): Promise<Rule[]> {
  const rules = await tx.doc(RulesDoc);
  const added: Rule[] = [];
  for (const rule of RELEASE_OWNER_RULES) {
    const key: RuleKey = rule;
    if (rules.owner.some((held) => sameKey(held, key))) continue;
    const stored: Rule = { ...rule, id: rules.nextId++, source: "release", addedAt: now };
    rules.owner.push(stored);
    added.push(JSON.parse(JSON.stringify(stored)) as Rule);
  }
  return added;
}

/**
 * Writes the default person rules once per cell, so a person's removal of a default permit stays
 * removed.
 */
export async function seedRules(tx: Tx, now: number): Promise<boolean> {
  const rules = await tx.doc(RulesDoc);
  if (rules.seeded) return false;
  for (const rule of DEFAULT_PERSON_RULES) {
    rules.person.push({ ...rule, id: rules.nextId++, source: "default", addedAt: now });
  }
  rules.seeded = true;
  return true;
}

/** Logs `rules.changed` for each release owner rule an open added. */
export function releaseRulesAdded(person: string, added: readonly Rule[]): void {
  for (const rule of added) changed({ person }, "owner", "add", "done", rule);
}

export async function listRules(parts: CellParts, context: Context): Promise<RuleLists> {
  const rules = await parts.harness.snapshot(RulesDoc, context);
  return { owner: rules?.owner ?? [], person: rules?.person ?? [] };
}

const sameMatch = (a: RuleMatch | undefined, b: RuleMatch | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.kind === b.kind && a.field === b.field && a.value === b.value;

const sameKey = (rule: RuleKey, key: RuleKey) =>
  rule.agent === key.agent && rule.tool === key.tool && sameMatch(rule.match, key.match);

/** The tool names any role of this cell can call. */
function knownTools(parts: CellParts): Set<string> {
  return new Set(
    [...parts.extensions.lead, ...parts.extensions.specialist].flatMap((extension) =>
      (extension.tools ?? []).map((tool) => tool.name),
    ),
  );
}

/**
 * The rule's agent, tool, and match checked and normalized (domains to hosts, text to its
 * normalized form). Throws RefusedChange with a reason a person can act on.
 */
function checkKey(parts: CellParts, input: unknown, agents: ReadonlySet<string>): RuleKey {
  const value = (input ?? {}) as Record<string, unknown>;
  const { agent, tool, match } = value;
  if (typeof agent !== "string" || !(agent === ALL_AGENTS || agents.has(agent))) {
    throw new RefusedChange(
      `unknown agent "${String(agent)}": use all, ${[...agents].sort().join(", ")}`,
    );
  }
  if (
    typeof tool !== "string" ||
    !(
      tool === ANY_TOOL ||
      tool === PAY_GROUP ||
      (TOOL_NAME.test(tool) && (tool.startsWith(PAY_PREFIX) || knownTools(parts).has(tool)))
    )
  ) {
    throw new RefusedChange(
      `unknown tool "${String(tool)}": use ${[...knownTools(parts)].sort().join(", ")}, pay, or *`,
    );
  }
  if (match === undefined || match === null) return { agent, tool };
  const given = match as Record<string, unknown>;
  const kind = given.kind as MatchKind;
  if (!MATCH_KINDS.includes(kind)) {
    throw new RefusedChange(`unknown match kind "${String(given.kind)}"`);
  }
  if (typeof given.field !== "string" || !FIELD.test(given.field)) {
    throw new RefusedChange("a match needs an argument name of letters, digits, or _");
  }
  if (typeof given.value !== "string" || given.value.trim() === "") {
    throw new RefusedChange("a match needs a value");
  }
  if (given.value.length > MATCH_VALUE_LIMIT) {
    throw new RefusedChange(`the match value is longer than ${MATCH_VALUE_LIMIT} characters`);
  }
  if (kind === "regex") {
    const problem = checkPattern(given.value);
    if (problem !== undefined) throw new RefusedChange(problem);
  }
  const normalized = normalizeMatchValue(kind, given.value);
  if (normalized === undefined || normalized === "") {
    throw new RefusedChange(`"${given.value}" is not a domain`);
  }
  return { agent, tool, match: { kind, field: given.field, value: normalized } };
}

async function agentsOf(parts: CellParts, context: Context): Promise<Set<string>> {
  const roster = await parts.harness.snapshot(RosterDoc, context);
  return new Set([LEAD_ROLE, ...Object.keys(roster?.specialists ?? {})]);
}

function changed(
  parts: Pick<CellParts, "person">,
  level: RuleLevel,
  action: "add" | "remove",
  outcome: "done" | "refused",
  rule: Partial<Rule> | undefined,
): void {
  logEvent("rules.changed", {
    cell: parts.person,
    level,
    action,
    outcome,
    rule_id: rule?.id ?? null,
    agent: typeof rule?.agent === "string" ? rule.agent : null,
    tool: typeof rule?.tool === "string" ? rule.tool : null,
    verdict: typeof rule?.verdict === "string" ? rule.verdict : null,
    match_kind: rule?.match?.kind ?? null,
  });
}

/** Adds an owner or person rule; refuses a person rule looser than an owner rule. */
export async function addRule(
  parts: CellParts,
  level: RuleLevel,
  input: unknown,
  now: number,
  context: Context,
): Promise<Rule> {
  const given = (input ?? {}) as Partial<RuleInput>;
  try {
    const key = checkKey(parts, input, await agentsOf(parts, context));
    const verdict = given.verdict as Verdict;
    if (!VERDICTS.includes(verdict)) {
      throw new RefusedChange(
        `unknown verdict "${String(given.verdict)}": use ${VERDICTS.join(", ")}`,
      );
    }
    const rule = await parts.harness.commit(async (tx) => {
      const rules = await tx.doc(RulesDoc);
      const list = level === "owner" ? rules.owner : rules.person;
      const candidate: RuleInput = { ...key, verdict };
      const existing = list.find((rule) => sameKey(rule, key));
      if (existing !== undefined) {
        throw new RefusedChange(`this rule already exists: ${ruleText(existing)}`);
      }
      if (list.length >= RULES_LIMIT) {
        throw new RefusedChange(`there are already ${RULES_LIMIT} rules; remove one first`);
      }
      if (level === "person") {
        const owner = looserThan(candidate, rules.owner);
        if (owner !== undefined) {
          throw new RefusedChange(
            `this rule is looser than an owner rule:\n  ${ruleText(owner)}\n  Your rules can be stricter than the owner's rules, never looser.`,
          );
        }
      }
      const stored: Rule = {
        ...candidate,
        id: rules.nextId++,
        source: level === "owner" ? "owner" : "person",
        addedAt: now,
      };
      list.push(stored);
      return JSON.parse(JSON.stringify(stored)) as Rule;
    }, context);
    changed(parts, level, "add", "done", rule);
    return rule;
  } catch (error) {
    if (error instanceof RefusedChange) changed(parts, level, "add", "refused", given);
    throw error;
  }
}

/**
 * Adds the person rule of an "allow always" answer inside the answer's own transaction, with the
 * checks of addRule: the limit, a duplicate, and a rule looser than an owner rule (RefusedChange,
 * which aborts the answer, so the call stays held). The rule comes from a real call, so its agent
 * and tool are known. Returns the stored rule, or undefined when the same rule already exists (a
 * person added it while the call waited). The caller logs `rules.changed` after the commit.
 */
export async function addAllowAlways(
  tx: Tx,
  input: RuleInput,
  now: number,
): Promise<Rule | undefined> {
  const rules = await tx.doc(RulesDoc);
  const existing = rules.person.find((rule) => sameKey(rule, input));
  if (existing !== undefined) {
    if (existing.verdict === input.verdict) return undefined;
    throw new RefusedChange(`this rule already exists: ${ruleText(existing)}`);
  }
  if (rules.person.length >= RULES_LIMIT) {
    throw new RefusedChange(`there are already ${RULES_LIMIT} rules; remove one first`);
  }
  const owner = looserThan(input, rules.owner);
  if (owner !== undefined) {
    throw new RefusedChange(
      `this rule is looser than an owner rule:\n  ${ruleText(owner)}\n  Your rules can be stricter than the owner's rules, never looser.`,
    );
  }
  const stored: Rule = { ...input, id: rules.nextId++, source: "allow-always", addedAt: now };
  rules.person.push(stored);
  return JSON.parse(JSON.stringify(stored)) as Rule;
}

/** Logs `rules.changed` for an allow-always rule that a committed answer added. */
export function allowAlwaysAdded(person: string, rule: Rule): void {
  changed({ person }, "person", "add", "done", rule);
}

/** Removes the rule with this agent, tool, and match; a release rule cannot be removed. */
export async function removeRule(
  parts: CellParts,
  level: RuleLevel,
  input: unknown,
  context: Context,
): Promise<Rule> {
  const given = (input ?? {}) as Partial<RuleInput>;
  try {
    const key = checkKey(parts, input, await agentsOf(parts, context));
    const removed = await parts.harness.commit(async (tx) => {
      const rules = await tx.doc(RulesDoc);
      const list = level === "owner" ? rules.owner : rules.person;
      const index = list.findIndex((rule) => sameKey(rule, key));
      const found = list[index];
      if (found === undefined) {
        throw new RuleNotFound(
          `no ${level === "owner" ? "owner " : ""}rule for ${key.agent} ${toolText(key.tool)} (${matchText(key.match)})`,
        );
      }
      if (found.source === "release") {
        throw new RefusedChange(`this rule is part of the release: ${ruleText(found)}`);
      }
      // A plain copy: the draft's objects are unusable once the commit settles.
      const copy = JSON.parse(JSON.stringify(found)) as Rule;
      list.splice(index, 1);
      return copy;
    }, context);
    changed(parts, level, "remove", "done", removed);
    return removed;
  } catch (error) {
    if (error instanceof RefusedChange) changed(parts, level, "remove", "refused", given);
    throw error;
  }
}
