/**
 * The one redactor. Every activity record, every guard log line, and (from later work) every
 * approval prompt and model state passes through it, so a secret-looking value never reaches a
 * person's screen, a log, or a model. It replaces:
 *
 * - the value of any field whose name looks secret (password, secret, token, api key,
 *   authorization, cookie, credential, private key; any case and separator);
 * - token-shaped text anywhere in a string (`Bearer …`, `sk-…`, `ghp_…`, JWT-shaped text, and
 *   hex or base64 runs over 32 characters);
 * - any literal value the caller names, and every secret value this process has learned
 *   (`addKnownSecretValues`: the values the secrets cell granted to this cell's agents), so the
 *   activity record, guard logs, approval prompts, the decision model's state, and the reviewer's
 *   input all redact them without passing them at each call site.
 *
 * Over-redaction is the safe direction: a long identifier that only looks like a token is hidden
 * too, and a value learned by one cell of a process is hidden in every cell of that process.
 */
import type { JsonValue } from "@earendil-works/chord";

export const REDACTED = "[redacted]";

/** A value shorter than this is never replaced (it would match ordinary text). */
const SHORTEST_VALUE = 4;

/** Secret values learned in this process; kept in memory only, never stored or logged. */
const knownSecretValues = new Set<string>();

/** Every later redaction also replaces these values. */
export function addKnownSecretValues(values: Iterable<string>): void {
  for (const value of values) {
    if (typeof value === "string" && value.length >= SHORTEST_VALUE) knownSecretValues.add(value);
  }
}

/** Tests: forget the learned values. */
export function clearKnownSecretValues(): void {
  knownSecretValues.clear();
}

const withKnown = (values: readonly string[]): readonly string[] =>
  knownSecretValues.size === 0 ? values : [...values, ...knownSecretValues];

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

/** True when a field name looks like it holds a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/** `text` with token-shaped parts, the named literal values, and the learned values replaced. */
export function redactText(text: string, values: readonly string[] = []): string {
  return replaceText(text, withKnown(values));
}

function replaceText(text: string, values: readonly string[]): string {
  let result = text;
  // Longest first, so a value that contains another is replaced whole.
  for (const value of [...values]
    .filter((v) => v.length >= SHORTEST_VALUE)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(value).join(REDACTED);
  }
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, REDACTED);
  result = result.replace(HEX_RUN, (run) => (/[0-9]/.test(run) ? REDACTED : run));
  return result.replace(BASE64_RUN, (run) =>
    /[A-Za-z]/.test(run) && /[0-9]/.test(run) ? REDACTED : run,
  );
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

/**
 * `value` with secret-looking fields and text replaced. With `maxBytes`, a top-level object over
 * the cap drops its largest fields first, never a `keep` field, and lists what it dropped under
 * `"…dropped"`.
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
  const candidates = Object.keys(fields)
    .filter((key) => !keep.has(key))
    .sort((a, b) => bytes(fields[b] ?? null) - bytes(fields[a] ?? null));
  const shaped = (): JsonValue =>
    dropped.length === 0 ? fields : { ...fields, "…dropped": dropped };
  for (const key of candidates) {
    if (bytes(shaped()) <= maxBytes) break;
    delete fields[key];
    dropped.push(key);
  }
  return shaped();
}
