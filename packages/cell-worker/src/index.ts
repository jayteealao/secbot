// The person-cell worker: health, the alarm check, and the CLI routes of each person's cell behind
// the device check. It forwards every request to the person's cell unchanged; it never looks at a
// message to decide where it goes.
//
// A fleet serves the cells named in SECBOT_FLEET_CELLS (empty: every cell, as on the test cell).
// Production runs the owner cell in one fleet and the second person and household cells in
// another, so each rollout stage deploys its own fleet (celld runs one application per fleet).
// Cell names follow the release workflows: `person` is the second person's cell. The secrets cell
// runs in the test fleet and beside the household cell in production; it is never snapshotted.
import {
  type AlarmReport,
  errorFields,
  type HouseholdChange,
  logEvent,
} from "@secbot/cell-harness";
import {
  HOUSEHOLD_CELL_NAME,
  HouseholdCell as HouseholdCellBase,
  type HouseholdCellEnv,
  type HouseholdCellState,
  isRefusedHouseholdChange,
} from "@secbot/household-cell";
import {
  SECRETS_CELL_NAME,
  SecretsCell as SecretsCellBase,
  type SecretsCellEnv,
  type SecretsCellState,
} from "@secbot/secrets-cell";
import { checkDevice, type DeviceEnv } from "./device-auth.ts";
import { type CellHealth, health, releaseVersion } from "./health.ts";
import { type HouseholdClientEnv, householdClientOf } from "./household-client.ts";
import { type GuardStub, hasOperatorKey, type OpsEnv, ops, type SnapshotStub } from "./ops.ts";
import {
  activityQuery,
  DEVICE_HEADER,
  householdOf,
  PERSON_HEADER,
  PersonCell,
  type PersonCellEnv,
} from "./person-cell.ts";
import {
  isSecretsMethod,
  SECRETS_CALLS,
  type SecretsClientEnv,
  secretsClientOf,
  secretsOf,
} from "./secrets-client.ts";

export { PersonCell };

/** The household cell with this bundle's release version. */
export class HouseholdCell extends HouseholdCellBase {
  constructor(state: HouseholdCellState, env: HouseholdCellEnv) {
    super(state, env, { version: releaseVersion() });
  }
}

/** The secrets cell with this bundle's release version and the host's key helper. */
export class SecretsCell extends SecretsCellBase {
  constructor(state: SecretsCellState, env: SecretsCellEnv) {
    super(state, env, { version: releaseVersion() });
  }
}

/** The person cells. */
export const PERSONS: readonly string[] = ["owner", "second"];
/** The household cell's name, the same one the household cell package uses. */
export const HOUSEHOLD = HOUSEHOLD_CELL_NAME;
/** The secrets cell's name, the same one the secrets cell package uses. */
export const SECRETS = SECRETS_CELL_NAME;
/** Every cell. */
export const ALL_CELLS: readonly string[] = [...PERSONS, HOUSEHOLD, SECRETS];

/** The release workflows' name for the second person's cell. */
export const cellName = (name: string): string => (name === "person" ? "second" : name);

/** The cells this fleet serves: SECBOT_FLEET_CELLS, or every cell when it is empty. */
export function fleetCells(env: { readonly SECBOT_FLEET_CELLS?: string }): string[] {
  const named = (env.SECBOT_FLEET_CELLS ?? "")
    .split(",")
    .map((name) => cellName(name.trim()))
    .filter(Boolean);
  return named.length === 0 ? [...ALL_CELLS] : [...new Set(named)];
}

export const anotherFleet = (cell: string) => `cell ${cell} is served by another fleet`;

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** The test cell's durability lab (test-cell bundle only). */
export interface LabNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike & {
    alarmReport?(): Promise<AlarmReport>;
    writeOne?(): Promise<void>;
  };
}

export interface WorkerEnv
  extends DeviceEnv,
    PersonCellEnv,
    HouseholdClientEnv,
    SecretsClientEnv,
    SecretsCellEnv,
    OpsEnv {
  readonly PERSON_CELL: DurableObjectNamespaceLike;
  readonly LAB?: LabNamespaceLike;
  readonly SECBOT_FLEET_CELLS?: string;
}

const cellOf = (env: WorkerEnv, person: string) =>
  env.PERSON_CELL.get(env.PERSON_CELL.idFromName(person));

async function cellStatus(env: WorkerEnv, name: string): Promise<CellHealth> {
  const person = cellName(name);
  if (ALL_CELLS.includes(person) && !fleetCells(env).includes(person)) {
    return { status: "down", reason: anotherFleet(person) };
  }
  if (person === HOUSEHOLD) {
    const household = householdOf(env);
    if (household?.status === undefined) return { status: "down", reason: "no household binding" };
    const status = await household.status();
    return { status: "up", version: status.version, roles: status.roles };
  }
  if (person === SECRETS) {
    const secrets = secretsOf(env);
    if (secrets === undefined) return { status: "down", reason: "no secrets binding" };
    const status = await secrets.status();
    return { status: "up", version: status.version, roles: status.roles };
  }
  if (!PERSONS.includes(person)) return { status: "down", reason: "unknown cell" };
  const response = await cellOf(env, person).fetch(
    new Request(`http://cell/v1/cells/${person}/status`, { headers: { [PERSON_HEADER]: person } }),
  );
  if (!response.ok) return { status: "down", reason: `status ${response.status}` };
  const body = (await response.json()) as { version: string; roles: string[] };
  return { status: "up", version: body.version, roles: body.roles };
}

type AlarmAnswer =
  | AlarmReport
  | { readonly cell: string; readonly ok: false; readonly reason: string };

async function alarmOf(env: WorkerEnv, name: string): Promise<AlarmAnswer> {
  if (ALL_CELLS.includes(name) && !fleetCells(env).includes(name)) {
    return { cell: name, ok: false, reason: anotherFleet(name) };
  }
  if (name === HOUSEHOLD) {
    const household = householdOf(env);
    if (household?.alarmReport === undefined) {
      return { cell: name, ok: false, reason: "no household binding" };
    }
    return (await household.alarmReport()) as AlarmReport;
  }
  if (name === SECRETS) {
    const secrets = secretsOf(env);
    if (secrets === undefined) return { cell: name, ok: false, reason: "no secrets binding" };
    return secrets.alarmReport();
  }
  if (name === "lab" && env.LAB !== undefined) {
    const lab = env.LAB.get(env.LAB.idFromName("lab"));
    if (lab.alarmReport === undefined) return { cell: name, ok: false, reason: "no lab" };
    return lab.alarmReport();
  }
  if (!PERSONS.includes(name)) return { cell: name, ok: false, reason: "unknown cell" };
  const response = await cellOf(env, name).fetch(
    new Request(`http://cell/v1/cells/${name}/alarm`, { headers: { [PERSON_HEADER]: name } }),
  );
  if (!response.ok) return { cell: name, ok: false, reason: `status ${response.status}` };
  return (await response.json()) as AlarmReport;
}

/**
 * GET /alarms?cells=owner,person,household: each named cell's stored alarm against its earliest
 * stored timer, read without re-arming. `person` is the second person's cell; no `cells` means
 * every cell this fleet serves. Like /health, it reveals times only and is reachable only from the
 * host (the release tool's curl).
 */
export async function alarms(url: URL, env: WorkerEnv): Promise<Response> {
  const named = (url.searchParams.get("cells") ?? "")
    .split(",")
    .map((name) => cellName(name.trim()))
    .filter(Boolean);
  const requested = named.length === 0 ? fleetCells(env) : named;
  const cells: Record<string, AlarmAnswer> = {};
  for (const name of [...new Set(requested)]) {
    try {
      cells[name] = await alarmOf(env, name);
    } catch (error) {
      cells[name] = {
        cell: name,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return Response.json({ version: releaseVersion(), cells });
}

type HouseholdRpc = NonNullable<ReturnType<typeof householdOf>>;

/** The snapshot RPC surface of one served cell, or undefined without a binding. */
function snapshotStubOf(env: WorkerEnv, cell: string): SnapshotStub | undefined {
  if (cell === HOUSEHOLD) {
    const household = householdOf(env) as (HouseholdRpc & Partial<SnapshotStub>) | undefined;
    return household?.snapshot === undefined ? undefined : (household as SnapshotStub);
  }
  if (!PERSONS.includes(cell)) return undefined;
  const stub = cellOf(env, cell) as DurableObjectStubLike & Partial<SnapshotStub>;
  return stub.snapshot === undefined ? undefined : (stub as SnapshotStub);
}

/** The guard RPC surface of one served person cell, or undefined for any other cell. */
function guardStubOf(env: WorkerEnv, cell: string): GuardStub | undefined {
  if (!PERSONS.includes(cell)) return undefined;
  const stub = cellOf(env, cell) as DurableObjectStubLike & Partial<GuardStub>;
  return stub.ownerRules === undefined ? undefined : (stub as GuardStub);
}

/**
 * POST /internal/household/{read,apply,status,budget,report-spend,set-budget,alert-sent}: the
 * household cell's RPC for a person cell in another fleet, over the private network with the
 * operator key. A change and a spend report carry their own operation id, so a retried call
 * applies once.
 */
async function internalHousehold(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!(await hasOperatorKey(request, env))) {
    logEvent("ops.refused", { route: url.pathname, reason: "operator_key" }, "warn");
    return Response.json({ error: "refused: operator_key" }, { status: 401 });
  }
  if (!fleetCells(env).includes(HOUSEHOLD)) {
    return Response.json({ error: anotherFleet(HOUSEHOLD) }, { status: 404 });
  }
  const household = householdOf(env);
  if (household === undefined) {
    return Response.json({ error: "no household binding" }, { status: 503 });
  }
  const method = url.pathname.slice("/internal/household/".length);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const fromCell = typeof body.fromCell === "string" ? body.fromCell : null;
  const document = typeof body.document === "string" ? body.document : null;
  try {
    if (request.method === "POST" && method === "read") {
      if (document === null) {
        return Response.json({ error: "send {document}" }, { status: 400 });
      }
      return Response.json(await household.read(document));
    }
    if (request.method === "POST" && method === "apply") {
      return Response.json(await household.apply(body as unknown as HouseholdChange));
    }
    if (method === "status" && household.status !== undefined) {
      return Response.json(await household.status());
    }
    if (request.method === "POST" && method === "budget" && household.budget !== undefined) {
      return Response.json(await household.budget());
    }
    if (
      request.method === "POST" &&
      method === "report-spend" &&
      household.reportSpend !== undefined
    ) {
      return Response.json(await household.reportSpend(body as never));
    }
    if (request.method === "POST" && method === "set-budget" && household.setBudget !== undefined) {
      return Response.json(await household.setBudget(body));
    }
    if (request.method === "POST" && method === "alert-sent" && household.alertSent !== undefined) {
      await household.alertSent(body as never);
      return Response.json({ ok: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A refused change is the caller's error; anything else is the cell's.
    const refused = isRefusedHouseholdChange(error);
    const status = refused ? 400 : 500;
    logEvent(
      refused ? "household.refused" : "household.error",
      { method, from_cell: fromCell, document, status, ...errorFields(error) },
      refused ? "warn" : "error",
    );
    return Response.json({ error: message }, { status });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * POST /internal/secrets/{get,broker,list,grant,revoke,add,allowlist,rotate,redaction-values,status}:
 * the secrets cell's RPC for a cell or an owner route in another fleet, over the private network
 * with the operator key. A refusal is 400 with the reason, a cell that cannot reach its key 503,
 * any other failure 500; no value is ever logged.
 */
async function internalSecrets(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!(await hasOperatorKey(request, env))) {
    logEvent("ops.refused", { route: url.pathname, reason: "operator_key" }, "warn");
    return Response.json({ error: "refused: operator_key" }, { status: 401 });
  }
  if (!fleetCells(env).includes(SECRETS)) {
    return Response.json({ error: anotherFleet(SECRETS) }, { status: 404 });
  }
  const method = url.pathname.slice("/internal/secrets/".length);
  if (request.method !== "POST" || (method !== "status" && !isSecretsMethod(method))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const secrets = secretsOf(env);
  if (secrets === undefined) return Response.json({ error: "no secrets binding" }, { status: 503 });
  // The body goes to the cell as it came; each method checks its own fields.
  const body = (await request.json().catch(() => ({}))) as never;
  try {
    if (method === "status") return Response.json(await secrets.status());
    if (!isSecretsMethod(method)) return Response.json({ error: "not found" }, { status: 404 });
    const answer = await SECRETS_CALLS[method](secrets, body);
    if (answer.ok) return Response.json(answer.value);
    // The secrets cell already logged the cause; the route notes the answer at warn.
    logEvent(
      answer.status < 500 ? "secrets.refused" : "secrets.answered_unavailable",
      { method, status: answer.status, reason: answer.error },
      "warn",
    );
    return Response.json({ error: answer.error }, { status: answer.status });
  } catch (error) {
    logEvent("secrets.error", { method, status: 500, ...errorFields(error) }, "error");
    return Response.json({ error: "the secrets cell failed" }, { status: 500 });
  }
}

const CELL_ROUTE = /^\/v1\/cells\/([a-z][a-z0-9-]{0,31})\//;

/** Every route except the test cell's conformance and lab routes. */
export async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    const named = url.searchParams.get("cells");
    if (named !== null) {
      url.searchParams.set(
        "cells",
        named
          .split(",")
          .map((name) => cellName(name.trim()))
          .join(","),
      );
    }
    return health(url, (person) => cellStatus(env, person));
  }
  if (request.method === "GET" && url.pathname === "/alarms") return alarms(url, env);
  if (url.pathname.startsWith("/ops/")) {
    const lab = env.LAB?.get(env.LAB.idFromName("lab"));
    return ops(request, env, {
      cells: fleetCells(env),
      stubOf: (cell) => snapshotStubOf(env, cell),
      guardOf: (cell) => guardStubOf(env, cell),
      activityQuery,
      household: () => householdClientOf(env),
      secrets: () => secretsClientOf(env),
      ...(lab?.writeOne === undefined
        ? {}
        : { write: () => lab.writeOne?.() ?? Promise.resolve() }),
    });
  }
  if (url.pathname.startsWith("/internal/household/")) return internalHousehold(request, env);
  if (url.pathname.startsWith("/internal/secrets/")) return internalSecrets(request, env);
  const person = CELL_ROUTE.exec(url.pathname)?.[1];
  if (person === undefined || !PERSONS.includes(person)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!fleetCells(env).includes(person)) {
    return Response.json({ error: anotherFleet(person) }, { status: 404 });
  }
  const check = await checkDevice(request, env, person);
  if (!check.ok) {
    return Response.json({ error: `refused: ${check.reason}` }, { status: check.status });
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set(PERSON_HEADER, person);
  headers.set(DEVICE_HEADER, check.device);
  return cellOf(env, person).fetch(new Request(request, { headers }));
}

export default {
  fetch: (request: Request, env: WorkerEnv): Promise<Response> => route(request, env),
};
