/**
 * The household's check of a shared-job exchange from a person cell: the person is one of the
 * household's people, and every operation has a known kind, an operation id, and fields of the
 * right shape and length. Anything else is refused before it reaches the shared store.
 */
import type { SharedOp, SharedSyncRequest } from "@secbot/cell-harness";
import { RefusedHouseholdChange } from "./change-log.ts";

/** The operation id pattern of the change log and the budget board. */
const OP_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** The most operations one exchange carries. */
export const SHARED_OPS_MAX = 50;

const PRIORITIES = ["urgent", "deadline", "routine", "research"] as const;
const TIERS = ["cheap", "mid", "frontier"] as const;
const EFFORTS = ["low", "medium", "high"] as const;

type Fields = Record<string, unknown>;

function refuse(message: string): never {
  throw new RefusedHouseholdChange(`refused shared job exchange: ${message}`);
}

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(op: Fields, field: string, max: number): string {
  const value = op[field];
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    refuse(`${field} must be text of 1 to ${max} characters`);
  }
  return value;
}

/**
 * One line of text with no brackets or control characters: the other person's lead reads it inside
 * a bracketed notice, so a title cannot close that notice and add an order of its own.
 */
function line(op: Fields, field: string, max: number): string {
  const value = text(op, field, max);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (/[[\]\u0000-\u001f\u007f]/.test(value)) {
    refuse(`${field} must be one line with no brackets`);
  }
  return value;
}

function number(op: Fields, field: string): number {
  const value = op[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    refuse(`${field} must be a job number`);
  }
  return value;
}

function oneOf<T extends string>(op: Fields, field: string, values: readonly T[]): T {
  const value = op[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    refuse(`${field} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function validateOp(value: unknown, person: string, persons: readonly string[]): SharedOp {
  if (!isObject(value)) refuse("an operation must be an object");
  const opId = value.opId;
  if (typeof opId !== "string" || !OP_ID.test(opId)) refuse("an operation needs an operation id");
  if (value.person !== person) refuse("an operation names another person");
  switch (value.kind) {
    case "propose": {
      const other = value.other;
      if (typeof other !== "string" || !persons.includes(other) || other === person) {
        refuse("the other person must be another person of the household");
      }
      const deadline = value.deadline;
      if (deadline !== null && (typeof deadline !== "string" || !ISO_DATE.test(deadline))) {
        refuse("deadline must be a date or null");
      }
      const estimate = value.estimateUsd;
      if (typeof estimate !== "number" || !(estimate >= 0) || estimate > 10_000) {
        refuse("estimateUsd must be a cost in USD");
      }
      return {
        kind: "propose",
        opId,
        person,
        other,
        local: number(value, "local"),
        title: line(value, "title", 80),
        brief: text(value, "brief", 8_000),
        priority: oneOf(value, "priority", PRIORITIES),
        deadline,
        tier: oneOf(value, "tier", TIERS),
        effort: oneOf(value, "effort", EFFORTS),
        estimateUsd: estimate,
      };
    }
    case "answer": {
      if (typeof value.join !== "boolean") refuse("join must be true or false");
      return {
        kind: "answer",
        opId,
        person,
        household: number(value, "household"),
        local: number(value, "local"),
        join: value.join,
      };
    }
    case "restart":
      return {
        kind: "restart",
        opId,
        person,
        household: number(value, "household"),
        note: text(value, "note", 2_000),
      };
    case "resume":
      return { kind: "resume", opId, person, household: number(value, "household") };
    case "stop":
      return { kind: "stop", opId, person };
    default:
      return refuse("unknown operation kind");
  }
}

/** Checks a shared-job exchange; throws `RefusedHouseholdChange` for anything malformed. */
export function validateSharedSync(value: unknown, persons: readonly string[]): SharedSyncRequest {
  if (!isObject(value)) refuse("the request must be an object");
  const person = value.person;
  if (typeof person !== "string" || !persons.includes(person)) {
    refuse("the person is not one of the household's people");
  }
  const ops = value.ops;
  if (!Array.isArray(ops) || ops.length > SHARED_OPS_MAX) {
    refuse(`ops must be a list of at most ${SHARED_OPS_MAX} operations`);
  }
  return { person, ops: ops.map((op) => validateOp(op, person, persons)) };
}
