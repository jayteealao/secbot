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
  type SetTimer,
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
import { type KeyCustody, SecretsCell, testCustody } from "@secbot/secrets-cell";
import { sha256Hex } from "../src/device-auth.ts";
import { type HouseholdStubLike, PersonCell, type SocketLike } from "../src/person-cell.ts";
import { route, type WorkerEnv } from "../src/routes.ts";
import type { SecretsStubLike } from "../src/secrets-client.ts";

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
  /** The secrets cell, when the setup has one (`secrets` given). */
  readonly secrets?: SecretsCell;
  /** The open harness of a person (opened by its first request). */
  harness(person: string): CellHarness;
  /**
   * The stand-in restart: closes the person's harness and drops its cell; the next request opens
   * a new cell on the same storage, as a restarted process does.
   */
  restart(person: string): Promise<void>;
}

export async function guardSetup(
  fleet?: string,
  options: {
    readonly guard?: OpenCellOptions["guard"];
    readonly respond?: Responder;
    /** The cost of one answered model step, in USD, by model id (default 0, as the faux model). */
    readonly stepCostUsd?: (modelId: string) => number;
    /** A household cell (with its budget board) behind the person cells' binding. */
    readonly household?: boolean;
    /**
     * The household's people: the household cell runs their shared jobs on the faux gateway, and
     * each person cell knows the other person to share with.
     */
    readonly persons?: readonly string[];
    /** The fetch the household cell uses for its outbound calls (heartbeat pings). */
    readonly householdFetch?: typeof fetch;
    /** The timer the household's shared jobs check both people's limits again with. */
    readonly householdSetTimer?: SetTimer;
    /** Extra worker settings per person cell (for example a household reached over HTTP). */
    readonly personEnv?: (person: string) => Record<string, string>;
    /** The person cells' environment (for example the alert stand-in's settings). */
    readonly cellEnv?: CellEnv;
    /** The fetch the person cells use for alerts. */
    readonly fetch?: typeof fetch;
    /** The person cells' clock (Date.now when absent). */
    readonly now?: () => number;
    /**
     * A secrets cell behind the SECRETS_CELL binding: `true` for a stand-in key custody, or the
     * custody and the fetch its broker calls use.
     */
    readonly secrets?: true | { readonly custody?: KeyCustody; readonly fetch?: typeof fetch };
    /**
     * Person cells that accept a session socket (as celld's hibernatable sockets): the test stubs
     * the global WebSocketPair and reads the frames from its server socket.
     */
    readonly sockets?: boolean;
    /** Fixed web pages a job can read with `read_fixture_page`. */
    readonly fixturePages?: OpenCellOptions["fixturePages"];
    /** The test cell's lookup tools in the person cells, with this wait (read at each call). */
    readonly fixtureTools?: OpenCellOptions["fixtureTools"];
    /** The test-cell switch in the household cell, with this slow lookup wait. */
    readonly householdFixtures?: { readonly slowMs: number };
  } = {},
): Promise<GuardSetup> {
  const gateway = createFauxGateway(
    options.respond ?? scripted,
    options.stepCostUsd === undefined ? {} : { stepCostUsd: options.stepCostUsd },
  );
  const household =
    options.household === true
      ? new HouseholdCell(
          { storage: new FakeCelldStorage() },
          options.householdFixtures === undefined ? {} : { SECBOT_TEST_FIXTURES: "1" },
          options.persons === undefined
            ? {}
            : {
                persons: options.persons,
                ...(options.householdFixtures === undefined
                  ? {}
                  : { fixtureTools: options.householdFixtures }),
                models: gateway.models,
                ...(options.now === undefined ? {} : { now: options.now }),
                ...(options.householdFetch === undefined ? {} : { fetch: options.householdFetch }),
                ...(options.householdSetTimer === undefined
                  ? {}
                  : { setTimer: options.householdSetTimer }),
              },
        )
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
  const secretsOptions = options.secrets === true ? {} : options.secrets;
  const secrets =
    secretsOptions === undefined
      ? undefined
      : new SecretsCell(
          { storage: new FakeCelldStorage() },
          {},
          {
            custody: secretsOptions.custody ?? testCustody(),
            ...(secretsOptions.fetch === undefined ? {} : { fetch: secretsOptions.fetch }),
          },
        );
  const secretsBinding =
    secrets === undefined
      ? {}
      : {
          SECRETS_CELL: {
            idFromName: (name: string) => name,
            // The secrets cell's methods are its RPC surface, as celld's stub exposes them.
            get: () => secrets as unknown as SecretsStubLike,
          },
        };
  const opened: CellHarness[] = [];
  const cells = new Map<string, PersonCell>();
  const byPerson = new Map<string, CellHarness>();
  const storages = new Map<string, FakeCelldStorage>();
  const cellFor = (person: string) => {
    let cell = cells.get(person);
    if (cell === undefined) {
      const storage = storages.get(person) ?? new FakeCelldStorage();
      storages.set(person, storage);
      const sockets: SocketLike[] = [];
      const tags = new Map<SocketLike, string[]>();
      const socketState =
        options.sockets === true
          ? {
              acceptWebSocket: (socket: SocketLike, given?: string[]) => {
                sockets.push(socket);
                tags.set(socket, given ?? []);
              },
              getWebSockets: () => sockets,
              getTags: (socket: SocketLike) => tags.get(socket) ?? [],
            }
          : {};
      cell = new PersonCell(
        { storage, ...socketState },
        { ...householdBinding, ...secretsBinding, ...options.personEnv?.(person) },
        async (storage, name, extras) => {
          const harness = await openCellHarness(storage, {
            person: name,
            version: "v0.0.0-test",
            env: options.cellEnv ?? {},
            models: gateway.models,
            ...(extras.household === undefined ? {} : { household: extras.household }),
            ...(extras.secrets === undefined ? {} : { secrets: extras.secrets }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.now === undefined ? {} : { now: options.now }),
            // The test-cell switch (SECBOT_TEST_FIXTURES in personEnv) gives the fixture pages and
            // lookup tools; a test's own pages win.
            ...(extras.fixturePages === undefined ? {} : { fixturePages: extras.fixturePages }),
            ...(extras.fixtureTools === undefined ? {} : { fixtureTools: extras.fixtureTools }),
            ...(options.fixturePages === undefined ? {} : { fixturePages: options.fixturePages }),
            ...(options.fixtureTools === undefined ? {} : { fixtureTools: options.fixtureTools }),
            ...(options.persons === undefined ? {} : { persons: options.persons }),
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
    ...secretsBinding,
  };
  return {
    env,
    cells,
    opened,
    gateway,
    ...(household === undefined ? {} : { household }),
    ...(secrets === undefined ? {} : { secrets }),
    harness: (person) => {
      const found = byPerson.get(person);
      if (found === undefined) throw new Error(`${person} is not open`);
      return found;
    },
    restart: async (person) => {
      const harness = byPerson.get(person);
      byPerson.delete(person);
      cells.delete(person);
      if (harness === undefined) return;
      opened.splice(opened.indexOf(harness), 1);
      await harness.close();
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
  await setup.secrets?.close();
}
