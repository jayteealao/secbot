/**
 * The one redactor. Every activity record, every guard log line, and (from later work) every
 * approval prompt and model state passes through it, so a secret-looking value never reaches a
 * person's screen, a log, or a model. It replaces:
 *
 * - the value of any field whose name looks secret (password, secret, token, api key,
 *   authorization, cookie, credential, private key; any case and separator);
 * - token-shaped text anywhere in a string (`Bearer …`, `sk-…`, `ghp_…`, JWT-shaped text, and
 *   hex or base64 runs over 32 characters);
 * - any literal value the caller names, and every secret value a cell of this process has
 *   learned (`setKnownSecretValues` and `addKnownSecretValues`: the values the secrets cell granted
 *   to that cell's agents), so the activity record, guard logs, approval prompts, the decision
 *   model's state, and the reviewer's input all redact them without passing them at each call site.
 *
 * Learned values are kept per cell: a cell's reload replaces its own set, and a closed cell's set
 * is dropped (`clearKnownSecretValues(cell)`). Redaction reads every cell's set, because
 * over-redaction is the safe direction: a long identifier that only looks like a token is hidden
 * too, and a value learned by one cell of a process is hidden in every cell of that process. A
 * UUID is an identifier, not a token, so it is kept.
 */
import type { JsonValue } from "@earendil-works/chord";

export const REDACTED = "[redacted]";

/** A value shorter than this is never replaced (it would match ordinary text). */
const SHORTEST_VALUE = 4;

/** Secret values learned per cell; kept in memory only, never stored or logged. */
const knownByCell = new Map<string, Set<string>>();
/** The set of values learned with no cell named. */
const ANY_CELL = "";

const usable = (values: Iterable<string>) =>
  [...values].filter((value) => typeof value === "string" && value.length >= SHORTEST_VALUE);

/** Every later redaction also replaces these values, learned by `cell`. */
export function addKnownSecretValues(values: Iterable<string>, cell = ANY_CELL): void {
  const set = knownByCell.get(cell) ?? new Set<string>();
  for (const value of usable(values)) set.add(value);
  if (set.size > 0) knownByCell.set(cell, set);
}

/** Replaces the values `cell` learned (a reload of its granted values). */
export function setKnownSecretValues(cell: string, values: Iterable<string>): void {
  const set = new Set(usable(values));
  if (set.size === 0) knownByCell.delete(cell);
  else knownByCell.set(cell, set);
}

/** Forgets the values `cell` learned, or every learned value when no cell is named (tests). */
export function clearKnownSecretValues(cell?: string): void {
  if (cell === undefined) knownByCell.clear();
  else knownByCell.delete(cell);
}

function withKnown(values: readonly string[]): readonly string[] {
  if (knownByCell.size === 0) return values;
  const all = [...values];
  for (const set of knownByCell.values()) all.push(...set);
  return all;
}

/** The largest redacted argument object a record keeps, in UTF-8 bytes. */
export const ARGUMENTS_LIMIT = 2_048;

const SECRET_KEY =
  /(password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey)/;

const TOKEN_SHAPES: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
];

/** A hex run over 32 characters that holds a digit. */
const HEX_RUN = /\b[0-9a-fA-F]{33,}\b/g;

/** A run of base64 characters over 32 long that holds both a letter and a digit. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{33,}={0,2}/g;

/** A UUID (any version): an identifier, never redacted for its shape alone. */
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** True when a base64-like run is token-shaped once the UUIDs inside it are set aside. */
function tokenLike(run: string): boolean {
  return run
    .split(UUID)
    .some((part) => part.length > 32 && /[A-Za-z]/.test(part) && /[0-9]/.test(part));
}

/** True when a field name looks like it holds a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/** `text` with token-shaped parts, the named literal values, and the learned values replaced. */
export function redactText(text: string, values: readonly string[] = []): string {
  return replaceText(text, withKnown(values));
}

/**
 * `text` with the named literal values, the learned values, and the distinctive token shapes
 * (`Bearer …`, `sk-…`, `ghp_…`, JWT) replaced, but not the generic hex and base64 runs: for a
 * service's answer, whose long ids and names are data the agent needs.
 */
export function redactTokens(text: string, values: readonly string[] = []): string {
  return replaceTokens(text, withKnown(values));
}

function replaceTokens(text: string, values: readonly string[]): string {
  let result = text;
  // Longest first, so a value that contains another is replaced whole.
  for (const value of [...values]
    .filter((v) => v.length >= SHORTEST_VALUE)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(value).join(REDACTED);
  }
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, REDACTED);
  return result;
}

function replaceText(text: string, values: readonly string[]): string {
  const result = replaceTokens(text, values).replace(HEX_RUN, (run) =>
    /[0-9]/.test(run) ? REDACTED : run,
  );
  return result.replace(BASE64_RUN, (run) => (tokenLike(run) ? REDACTED : run));
}

export interface RedactOptions {
  /** Literal secret values to replace wherever they appear. */
  readonly values?: readonly string[];
  /** Top-level fields the size cap must keep (the fields a rule matched). */
  readonly keep?: readonly string[];
  /** The size cap for a top-level object, in UTF-8 bytes; no cap when absent. */
  readonly maxBytes?: number;
}

function redactValue(value: JsonValue, values: readonly string[]): JsonValue {
  if (typeof value === "string") return replaceText(value, values);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, values));
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = isSecretKey(key) ? REDACTED : redactValue(item, values);
    }
    return out;
  }
  return value;
}

const bytes = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value)).length;

/** A kept text field over the cap is cut to this many characters. */
export const KEPT_TEXT_LIMIT = 512;

const cut = (text: string) =>
  text.length > KEPT_TEXT_LIMIT
    ? `${text.slice(0, KEPT_TEXT_LIMIT)} [cut from ${text.length} characters]`
    : text;

/**
 * `value` with secret-looking fields and text replaced. With `maxBytes`, a top-level object over
 * the cap drops its largest fields first, never a `keep` field, and lists what it dropped under
 * `"…dropped"`; when the kept fields alone are still over the cap, each kept text is cut to
 * KEPT_TEXT_LIMIT characters, so an agent's long value never passes the cap whole. A rule decides
 * on the whole value before this runs.
 */
export function redact(value: JsonValue, options: RedactOptions = {}): JsonValue {
  const redacted = redactValue(value, withKnown(options.values ?? []));
  const { maxBytes } = options;
  if (
    maxBytes === undefined ||
    redacted === null ||
    typeof redacted !== "object" ||
    Array.isArray(redacted) ||
    bytes(redacted) <= maxBytes
  ) {
    return redacted;
  }
  const keep = new Set(options.keep ?? []);
  const fields = { ...redacted };
  const dropped: string[] = [];
  const size = new Map(Object.keys(fields).map((key) => [key, bytes(fields[key] ?? null)]));
  const candidates = Object.keys(fields)
    .filter((key) => !keep.has(key))
    .sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0));
  const shaped = (): JsonValue =>
    dropped.length === 0 ? fields : { ...fields, "…dropped": dropped };
  for (const key of candidates) {
    if (bytes(shaped()) <= maxBytes) break;
    delete fields[key];
    dropped.push(key);
  }
  if (bytes(shaped()) > maxBytes) {
    for (const key of keep) {
      const kept = fields[key];
      if (typeof kept === "string") fields[key] = cut(kept);
    }
  }
  return shaped();
}
