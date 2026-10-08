/**
 * The worker and person cells on the stand-in, for the guard's routes: the device check, the
 * operator key, and person cells whose stubs expose both `fetch` and the RPC methods (as celld's
 * stubs do). A scripted faux model makes tool calls from a chat line that starts with `CALL`.
 */
import type { JsonValue } from "@earendil-works/chord";
import { type CellHarness, openCellHarness } from "@secbot/cell-harness";
import {
  createFauxGateway,
  FakeCelldStorage,
  type FauxGateway,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@secbot/cell-harness/testing";
import { sha256Hex } from "../src/device-auth.ts";
import { route, type WorkerEnv } from "../src/index.ts";
import { PersonCell } from "../src/person-cell.ts";

export const KEY = "owner-laptop-key-0123456789abcdef0123456789abcdef";
export const OPERATOR_KEY = "operator-key-fedcba9876543210fedcba9876543210";
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
  /** The open harness of a person (opened by its first request). */
  harness(person: string): CellHarness;
}

export async function guardSetup(fleet?: string): Promise<GuardSetup> {
  const gateway = createFauxGateway(scripted);
  const opened: CellHarness[] = [];
  const cells = new Map<string, PersonCell>();
  const byPerson = new Map<string, CellHarness>();
  const cellFor = (person: string) => {
    let cell = cells.get(person);
    if (cell === undefined) {
      cell = new PersonCell({ storage: new FakeCelldStorage() }, {}, async (storage, name) => {
        const harness = await openCellHarness(storage, {
          person: name,
          version: "v0.0.0-test",
          env: {},
          models: gateway.models,
        });
        opened.push(harness);
        byPerson.set(name, harness);
        return harness;
      });
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
  };
  return {
    env,
    cells,
    opened,
    gateway,
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
}
