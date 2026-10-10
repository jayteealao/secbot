/**
 * The rule engine: deterministic, and always first in the guard. A rule names an agent (`all` or
 * a role), a tool (a tool name, `*` for any tool, or `pay` for every tool named `pay_…`), an
 * optional argument match, and a verdict.
 *
 * Evaluation (the precedence of the guard):
 * 1. Each argument value is normalized: NFKC, URL decoding repeated until stable (at most three
 *    passes), lower case; domains through the WHATWG URL parser (lower-case ASCII host).
 * 2. Inside one level (owner, person), the most specific matching rule decides: an agent name
 *    before `all`, a tool name before the pay group before `*`, a match before none, and exact
 *    before prefix before domain before regular expression. On a tie the stricter verdict wins.
 * 3. Across the levels the strictest verdict wins: prohibit, then ask first, then permit. So a
 *    person can never loosen an owner rule. A call no rule matches passes the rule stage.
 *
 * Fail-closed matching: a prohibit or ask-first rule matches when any candidate value matches (an
 * array element, one of several e-mail domains); a permit rule matches only when every candidate
 * does. A regular expression runs on at most REGEX_INPUT_LIMIT characters; a longer value counts as
 * a match for a prohibit or ask-first rule and as no match for a permit rule, so the bound never
 * loosens a rule.
 */
import type { JsonValue } from "@earendil-works/chord";

export type Verdict = "permit" | "ask-first" | "prohibit";
export type MatchKind = "exact" | "prefix" | "email-domain" | "web-domain" | "regex";
export type RuleLevel = "owner" | "person";
export type RuleSource = "release" | "default" | "owner" | "person" | "allow-always";

export type RuleMatch = { kind: MatchKind; field: string; value: string };

/** A rule as a person or the owner writes it. */
export type RuleInput = { agent: string; tool: string; verdict: Verdict; match?: RuleMatch };

export type Rule = RuleInput & { id: number; source: RuleSource; addedAt: number };

/** What the rule engine sees of one tool call. */
export interface RuleCall {
  readonly role: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export interface Decision {
  /** Undefined when no rule matched. */
  readonly verdict: Verdict | undefined;
  readonly rule: Rule | undefined;
  readonly level: RuleLevel | undefined;
  /** The argument fields the deciding rule matched (kept whole in the record). */
  readonly matched: readonly string[];
}

export const VERDICTS: readonly Verdict[] = ["permit", "ask-first", "prohibit"];
export const MATCH_KINDS: readonly MatchKind[] = [
  "exact",
  "prefix",
  "email-domain",
  "web-domain",
  "regex",
];

/** The pay group: every tool whose name starts with this prefix. */
export const PAY_PREFIX = "pay_";
export const PAY_GROUP = "pay";
export const ANY_TOOL = "*";
export const ALL_AGENTS = "all";

/** The longest value a regular expression runs on. */
export const REGEX_INPUT_LIMIT = 4_096;
/** The longest pattern a rule may hold. */
export const PATTERN_LIMIT = 200;

const STRICTNESS: Record<Verdict, number> = { permit: 0, "ask-first": 1, prohibit: 2 };

export const stricter = (a: Verdict, b: Verdict): Verdict =>
  STRICTNESS[a] >= STRICTNESS[b] ? a : b;

function decodeRepeatedly(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** NFKC, URL decoding until stable (at most three passes), lower case. */
export function normalizeText(raw: string): string {
  return decodeRepeatedly(raw.normalize("NFKC")).normalize("NFKC").toLowerCase();
}

/** The lower-case ASCII host of a URL or a bare host, without a trailing dot; undefined if none. */
export function hostOf(raw: string): string | undefined {
  const text = normalizeText(raw).trim();
  if (text === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
  try {
    const host = new URL(withScheme).hostname.replace(/\.$/, "");
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/** Every e-mail domain in a value (`a@x.com, b@y.org` gives both), each through hostOf. */
export function emailDomainsOf(raw: string): string[] {
  const text = normalizeText(raw);
  const domains: string[] = [];
  for (const found of text.matchAll(/@([^\s@,;<>"'()[\]]+)/g)) {
    const host = hostOf(found[1] ?? "");
    if (host !== undefined) domains.push(host);
  }
  return domains;
}

const domainMatches = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

/** The rule's stored value for a match kind: normalized text, a host, or the pattern as given. */
export function normalizeMatchValue(kind: MatchKind, raw: string): string | undefined {
  if (kind === "regex") return raw;
  if (kind === "email-domain") return hostOf(raw.replace(/^.*@/, ""));
  if (kind === "web-domain") return hostOf(raw);
  return normalizeText(raw);
}

/** A field value as the strings a match compares: array elements each; other JSON as its text. */
function candidatesOf(value: JsonValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => candidatesOf(item));
  if (typeof value === "string") return [value];
  return [JSON.stringify(value)];
}

const patternCache = new Map<string, RegExp>();
function patternOf(source: string): RegExp {
  let pattern = patternCache.get(source);
  if (pattern === undefined) {
    pattern = new RegExp(source, "i");
    if (patternCache.size > 500) patternCache.clear();
    patternCache.set(source, pattern);
  }
  return pattern;
}

/** One candidate against one match; `strict` is true for prohibit and ask-first rules. */
function valueMatches(match: RuleMatch, raw: string, strict: boolean): boolean {
  switch (match.kind) {
    case "exact":
      return normalizeText(raw) === match.value;
    case "prefix":
      return normalizeText(raw).startsWith(match.value);
    case "web-domain": {
      const host = hostOf(raw);
      return host !== undefined && domainMatches(host, match.value);
    }
    case "email-domain": {
      const domains = emailDomainsOf(raw);
      if (domains.length === 0) return false;
      return strict
        ? domains.some((host) => domainMatches(host, match.value))
        : domains.every((host) => domainMatches(host, match.value));
    }
    case "regex": {
      const text = normalizeText(raw);
      if (text.length > REGEX_INPUT_LIMIT) return strict;
      return patternOf(match.value).test(text);
    }
  }
}

function fieldMatches(match: RuleMatch, call: RuleCall, strict: boolean): boolean {
  const candidates = Object.hasOwn(call.arguments, match.field)
    ? candidatesOf(call.arguments[match.field])
    : [];
  if (candidates.length === 0) return false;
  return strict
    ? candidates.some((raw) => valueMatches(match, raw, true))
    : candidates.every((raw) => valueMatches(match, raw, false));
}

export function toolMatches(selector: string, tool: string): boolean {
  if (selector === ANY_TOOL) return true;
  if (selector === PAY_GROUP) return tool.startsWith(PAY_PREFIX);
  return selector === tool;
}

/** True when the rule applies to the call. */
export function matches(rule: RuleInput, call: RuleCall): boolean {
  if (rule.agent !== ALL_AGENTS && rule.agent !== call.role) return false;
  if (!toolMatches(rule.tool, call.tool)) return false;
  if (rule.match === undefined) return true;
  return fieldMatches(rule.match, call, rule.verdict !== "permit");
}

const MATCH_RANK: Record<MatchKind, number> = {
  exact: 4,
  prefix: 3,
  "email-domain": 2,
  "web-domain": 2,
  regex: 1,
};

/** Specificity as a tuple compared left to right: agent, tool, match. */
export function specificity(rule: RuleInput): readonly [number, number, number] {
  const agent = rule.agent === ALL_AGENTS ? 0 : 1;
  const tool = rule.tool === ANY_TOOL ? 0 : rule.tool === PAY_GROUP ? 1 : 2;
  const match = rule.match === undefined ? 0 : MATCH_RANK[rule.match.kind];
  return [agent, tool, match];
}

function compareSpecificity(a: RuleInput, b: RuleInput): number {
  const [sa, sb] = [specificity(a), specificity(b)];
  for (let index = 0; index < 3; index++) {
    const diff = (sa[index] ?? 0) - (sb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return STRICTNESS[a.verdict] - STRICTNESS[b.verdict];
}

/** The deciding rule inside one level, or undefined when none matches. */
export function decideLevel(rules: readonly Rule[], call: RuleCall): Rule | undefined {
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!matches(rule, call)) continue;
    if (best === undefined || compareSpecificity(rule, best) > 0) best = rule;
  }
  return best;
}

/** The rule stage's decision for one call. */
export function decide(owner: readonly Rule[], person: readonly Rule[], call: RuleCall): Decision {
  const fromOwner = decideLevel(owner, call);
  const fromPerson = decideLevel(person, call);
  let rule: Rule | undefined;
  let level: RuleLevel | undefined;
  if (fromOwner !== undefined && fromPerson !== undefined) {
    // Strictest across levels; the owner rule is named when both say the same.
    const ownerWins = STRICTNESS[fromOwner.verdict] >= STRICTNESS[fromPerson.verdict];
    [rule, level] = ownerWins ? [fromOwner, "owner"] : [fromPerson, "person"];
  } else if (fromOwner !== undefined) {
    [rule, level] = [fromOwner, "owner"];
  } else if (fromPerson !== undefined) {
    [rule, level] = [fromPerson, "person"];
  }
  return {
    verdict: rule?.verdict,
    rule,
    level,
    matched: rule?.match === undefined ? [] : [rule.match.field],
  };
}

const agentsOverlap = (a: string, b: string) => a === ALL_AGENTS || b === ALL_AGENTS || a === b;

function toolsOverlap(a: string, b: string): boolean {
  if (a === ANY_TOOL || b === ANY_TOOL || a === b) return true;
  if (a === PAY_GROUP) return b.startsWith(PAY_PREFIX);
  if (b === PAY_GROUP) return a.startsWith(PAY_PREFIX);
  return false;
}

/**
 * Whether a person match and an owner match can both apply to one call. Conservative: they overlap
 * unless they name different fields, or the person match is exact and the owner match does not
 * accept its value (two exact matches compare their values). A doubtful case overlaps, so a looser
 * rule is refused rather than accepted.
 */
function matchesOverlap(person: RuleMatch | undefined, owner: RuleMatch | undefined): boolean {
  if (person === undefined || owner === undefined) return true;
  if (person.field !== owner.field) return false;
  if (person.kind === "exact") return valueMatches(owner, person.value, true);
  return true;
}

/** The owner rule that a person rule would loosen, or undefined when it stays inside them. */
export function looserThan(person: RuleInput, owner: readonly Rule[]): Rule | undefined {
  return owner.find(
    (rule) =>
      STRICTNESS[person.verdict] < STRICTNESS[rule.verdict] &&
      agentsOverlap(person.agent, rule.agent) &&
      toolsOverlap(person.tool, rule.tool) &&
      matchesOverlap(person.match, rule.match),
  );
}

/**
 * Why a pattern is refused, or undefined when it is accepted. Refused: over PATTERN_LIMIT
 * characters, invalid, a back-reference, a look-around, a repeated group that itself repeats or
 * has alternatives, and more than one repeat (`*`, `+`, `{n,}`, `{n,m}` with m over 1). One
 * repeat over at most REGEX_INPUT_LIMIT characters bounds the backtracking.
 */
export function checkPattern(source: string): string | undefined {
  if (source.length === 0) return "the pattern is empty";
  if (source.length > PATTERN_LIMIT)
    return `the pattern is longer than ${PATTERN_LIMIT} characters`;
  try {
    new RegExp(source, "i");
  } catch {
    return "the pattern is not a valid regular expression";
  }
  type Group = { alternatives: boolean; repeats: boolean };
  const stack: Group[] = [{ alternatives: false, repeats: false }];
  let repeats = 0;
  let index = 0;
  /** Reads a quantifier at `index`; returns whether it can repeat more than once. */
  const quantifier = (): { found: boolean; repeat: boolean } => {
    const char = source[index];
    if (char === "*" || char === "+") {
      index++;
      if (source[index] === "?") index++;
      return { found: true, repeat: true };
    }
    if (char === "?") {
      index++;
      if (source[index] === "?") index++;
      return { found: true, repeat: false };
    }
    if (char === "{") {
      const braces = /^\{(\d+)(,(\d*))?\}\??/.exec(source.slice(index));
      if (braces !== null) {
        index += braces[0].length;
        const max =
          braces[2] === undefined
            ? Number(braces[1])
            : braces[3] === ""
              ? Infinity
              : Number(braces[3]);
        return { found: true, repeat: max > 1 };
      }
    }
    return { found: false, repeat: false };
  };
  while (index < source.length) {
    const char = source[index];
    const top = stack[stack.length - 1] as Group;
    if (char === "\\") {
      const next = source[index + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") return "the pattern uses a back-reference";
      index += 2;
    } else if (char === "[") {
      index++;
      while (index < source.length && source[index] !== "]") {
        index += source[index] === "\\" ? 2 : 1;
      }
      index++;
    } else if (char === "(") {
      if (/^\(\?(=|!|<=|<!)/.test(source.slice(index))) return "the pattern uses a look-around";
      stack.push({ alternatives: false, repeats: false });
      index += source.startsWith("(?<", index)
        ? source.indexOf(">", index) + 1 - index
        : source.startsWith("(?:", index)
          ? 3
          : 1;
      continue;
    } else if (char === ")") {
      const group = stack.pop() as Group;
      index++;
      const after = quantifier();
      if (after.found && after.repeat) {
        if (group.alternatives || group.repeats) {
          return "the pattern repeats a group that repeats or has alternatives";
        }
        repeats++;
      }
      const parent = stack[stack.length - 1] as Group;
      parent.repeats ||= group.repeats || after.repeat;
      continue;
    } else if (char === "|") {
      top.alternatives = true;
      index++;
      continue;
    } else {
      index++;
    }
    const after = quantifier();
    if (after.repeat) {
      repeats++;
      top.repeats = true;
    }
  }
  if (repeats > 1) return "the pattern has more than one repeat (*, +, or {n,})";
  return undefined;
}

const MATCH_SYMBOL: Record<MatchKind, string> = {
  exact: "=",
  prefix: "^=",
  "email-domain": "@",
  "web-domain": "host",
  regex: "~",
};

export function matchText(match: RuleMatch | undefined): string {
  if (match === undefined) return "any";
  const value = match.kind === "regex" ? `/${match.value}/i` : match.value;
  return `${match.field} ${MATCH_SYMBOL[match.kind]} ${value}`;
}

export const verdictText = (verdict: Verdict) => (verdict === "ask-first" ? "ask first" : verdict);

export const toolText = (tool: string) =>
  tool === PAY_GROUP ? "pay tools" : tool === ANY_TOOL ? "any tool" : tool;

/** A rule in the command line's form, for example `lead handoff (any) -> ask first`. */
export function ruleText(rule: RuleInput): string {
  if (rule.tool === PAY_GROUP && rule.match === undefined) {
    const who = rule.agent === ALL_AGENTS ? "any" : `${rule.agent}: any`;
    return `${who} pay tool -> ${verdictText(rule.verdict)}`;
  }
  return `${rule.agent} ${toolText(rule.tool)} (${matchText(rule.match)}) -> ${verdictText(rule.verdict)}`;
}
