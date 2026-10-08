/**
 * The worker and person cells on the stand-in, for the guard's routes: the device check, the
 * operator key, and person cells whose stubs expose both `fetch` and the RPC methods (as celld's
 * stubs do). A scripted faux model makes tool calls from a chat line that starts with `CALL`.
 */
import type { JsonValue } from "@earendil-works/chord";
import {
  type CellEnv,
  type CellHarness,
  type OpenCellOptions,
  openCellHarness,
} from "@secbot/cell-harness";
import {
  createFauxGateway,
  FakeCelldStorage,
  type FauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  passingDecision,
  type Responder,
} from "@secbot/cell-harness/testing";
import { HouseholdCell } from "@secbot/household-cell";
import { sha256Hex } from "../src/device-auth.ts";
import { route, type WorkerEnv } from "../src/index.ts";
import { type HouseholdStubLike, PersonCell } from "../src/person-cell.ts";

export const KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef";
export const OPERATOR_KEY = "operator-key-fedcba9876543210fedcba9876543210"; // gitleaks:allow (fake test key)
export const HOST = "cells.example.test";

/** `CALL <tool> <json>` per line makes those tool calls; anything else gets a short answer. */
export function scripted(request: FauxRequest) {
  if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("done")]);
  if (!request.lastText.startsWith("CALL ")) return fauxAssistantMessage([fauxText("ok")]);
  const calls = request.lastText.split("\n").map((line) => {
    const [, tool = "", json = "{}"] = /^CALL (\S+) ?(.*)$/.exec(line) ?? [];
    return fauxToolCall(tool, JSON.parse(json || "{}") as Record<string, JsonValue>);
  });
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

export interface GuardSetup {
  readonly env: WorkerEnv;
  readonly cells: Map<string, PersonCell>;
  readonly opened: CellHarness[];
  readonly gateway: FauxGateway;
  /** The household cell, when the setup has one (`household: true`). */
  readonly household?: HouseholdCell;
  /** The open harness of a person (opened by its first request). */
  harness(person: string): CellHarness;
}

export async function guardSetup(
  fleet?: string,
  options: {
    readonly guard?: OpenCellOptions["guard"];
    readonly respond?: Responder;
    /** A household cell (with its budget board) behind the person cells' binding. */
    readonly household?: boolean;
    /** The person cells' environment (for example the alert stand-in's settings). */
    readonly cellEnv?: CellEnv;
    /** The fetch the person cells use for alerts. */
    readonly fetch?: typeof fetch;
  } = {},
): Promise<GuardSetup> {
  const household =
    options.household === true
      ? new HouseholdCell({ storage: new FakeCelldStorage() }, {})
      : undefined;
  const householdBinding =
    household === undefined
      ? {}
      : {
          HOUSEHOLD_CELL: {
            idFromName: (name: string) => name,
            // The household cell's methods are its RPC surface, as celld's stub exposes them.
            get: () => household as unknown as HouseholdStubLike,
          },
        };
  const gateway = createFauxGateway(options.respond ?? scripted);
  const opened: CellHarness[] = [];
  const cells = new Map<string, PersonCell>();
  const byPerson = new Map<string, CellHarness>();
  const cellFor = (person: string) => {
    let cell = cells.get(person);
    if (cell === undefined) {
      cell = new PersonCell(
        { storage: new FakeCelldStorage() },
        householdBinding,
        async (storage, name, extras) => {
          const harness = await openCellHarness(storage, {
            person: name,
            version: "v0.0.0-test",
            env: options.cellEnv ?? {},
            models: gateway.models,
            ...(extras.household === undefined ? {} : { household: extras.household }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            // A passing decision model unless a test gives its own: the suites that are not about
            // the model layers keep their request counts.
            guard: { decision: passingDecision, ...options.guard },
          });
          opened.push(harness);
          byPerson.set(name, harness);
          return harness;
        },
      );
      cells.set(person, cell);
    }
    return cell;
  };
  const env: WorkerEnv = {
    SECBOT_DEVICE_KEYS: `laptop:owner:${await sha256Hex(KEY)}`,
    SECBOT_PRIVATE_HOSTS: HOST,
    SECBOT_OPERATOR_KEY: OPERATOR_KEY,
    ...(fleet === undefined ? {} : { SECBOT_FLEET_CELLS: fleet }),
    PERSON_CELL: { idFromName: (name) => name, get: (id) => cellFor(String(id)) },
    ...householdBinding,
  };
  return {
    env,
    cells,
    opened,
    gateway,
    ...(household === undefined ? {} : { household }),
    harness: (person) => {
      const found = byPerson.get(person);
      if (found === undefined) throw new Error(`${person} is not open`);
      return found;
    },
  };
}

/** A fetch that serves the worker's routes in process. */
export const workerFetch =
  (setup: GuardSetup): typeof fetch =>
  (input, init) =>
    route(new Request(input instanceof Request ? input : String(input), init), setup.env);

export async function closeAll(setup: GuardSetup): Promise<void> {
  for (const harness of setup.opened) await harness.close();
  await setup.household?.close();
}
