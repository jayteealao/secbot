/**
 * Assertions for pi-durable's runner-independent conformance cases, inside a celld isolate.
 *
 * pi-durable's own adapter (`createExpectAssertions`) maps these to Vitest's `toEqual` and
 * `toMatchObject`. celld's `node:assert` has no `partialDeepStrictEqual`, and its
 * `deepStrictEqual` treats an `undefined` property as a difference where `toEqual` does not
 * (source: .scratch/sources/git/celld/crates/celld/js/node_assert.js:204-293, celld v0.6.1).
 * So this module implements the two comparisons with Vitest's semantics instead.
 */
import type { StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";

export class ConformanceAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceAssertionError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const describe = (value: unknown): string => {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? `${item}n` : item,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
};

const fail = (message: string): never => {
  throw new ConformanceAssertionError(message);
};

/** Vitest `toEqual`: recursive equality that ignores properties whose value is undefined. */
export function looselyEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return (
      actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
    );
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length)
      return false;
    return actual.every((item, index) => looselyEqual(item, expected[index]));
  }
  if (!isObject(actual) || !isObject(expected)) return false;
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    if (!looselyEqual(actual[key], expected[key])) return false;
  }
  return true;
}

/** Vitest `toMatchObject`: every property of `expected` matches; arrays match element by element. */
export function partiallyEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => partiallyEqual(actual[index], item));
  }
  if (isObject(expected) && !(expected instanceof Uint8Array)) {
    if (!isObject(actual)) return false;
    return Object.keys(expected).every(
      (key) => key in actual && partiallyEqual(actual[key], expected[key]),
    );
  }
  return looselyEqual(actual, expected);
}

export const cellAssertions: StorageConformanceAssertions = {
  ok(value, message) {
    if (!value) fail(message ?? `expected a truthy value, got ${describe(value)}`);
  },
  strictEqual(actual, expected) {
    if (!Object.is(actual, expected))
      fail(`expected ${describe(actual)} to be ${describe(expected)}`);
  },
  deepEqual(actual, expected) {
    if (!looselyEqual(actual, expected))
      fail(`expected ${describe(actual)} to equal ${describe(expected)}`);
  },
  partialDeepEqual(actual, expected) {
    if (!partiallyEqual(actual, expected))
      fail(`expected ${describe(actual)} to match ${describe(expected)}`);
  },
  greaterThan(actual, expected) {
    if (!(actual > expected)) fail(`expected ${actual} to be greater than ${expected}`);
  },
  async rejects(operation, messageIncludes) {
    let settled: { error: unknown } | undefined;
    try {
      await operation;
    } catch (error) {
      settled = { error };
    }
    if (settled === undefined)
      return fail(`expected a rejection that includes "${messageIncludes}"`);
    const message = settled.error instanceof Error ? settled.error.message : String(settled.error);
    if (!message.includes(messageIncludes)) {
      fail(`expected a rejection that includes "${messageIncludes}", got "${message}"`);
    }
  },
};
