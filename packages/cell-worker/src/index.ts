// The person-cell worker: health, the alarm check, and the CLI routes of each person's cell behind
// the device check. It forwards every request to the person's cell unchanged; it never looks at a
// message to decide where it goes.
import type { AlarmReport } from "@secbot/cell-harness";
import {
  HOUSEHOLD_CELL_NAME,
  HouseholdCell as HouseholdCellBase,
  type HouseholdCellEnv,
  type HouseholdCellState,
} from "@secbot/household-cell";
import { checkDevice, type DeviceEnv } from "./device-auth.ts";
import { type CellHealth, health, releaseVersion } from "./health.ts";
import {
  DEVICE_HEADER,
  householdOf,
  PERSON_HEADER,
  PersonCell,
  type PersonCellEnv,
} from "./person-cell.ts";

export { PersonCell };

/** The household cell with this bundle's release version. */
export class HouseholdCell extends HouseholdCellBase {
  constructor(state: HouseholdCellState, env: HouseholdCellEnv) {
    super(state, env, { version: releaseVersion() });
  }
}

/** The person cells of wave 1. */
export const PERSONS: readonly string[] = ["owner", "second"];
/** The household cell's name, the same one the household cell package uses. */
export const HOUSEHOLD = HOUSEHOLD_CELL_NAME;

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
  get(id: unknown): DurableObjectStubLike & { alarmReport?(): Promise<AlarmReport> };
}

export interface WorkerEnv extends DeviceEnv, PersonCellEnv {
  readonly PERSON_CELL: DurableObjectNamespaceLike;
  readonly LAB?: LabNamespaceLike;
}

const cellOf = (env: WorkerEnv, person: string) =>
  env.PERSON_CELL.get(env.PERSON_CELL.idFromName(person));

async function cellStatus(env: WorkerEnv, person: string): Promise<CellHealth> {
  if (person === HOUSEHOLD) {
    const household = householdOf(env);
    if (household?.status === undefined) return { status: "down", reason: "no household binding" };
    const status = await household.status();
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
  if (name === HOUSEHOLD) {
    const household = householdOf(env);
    if (household?.alarmReport === undefined) {
      return { cell: name, ok: false, reason: "no household binding" };
    }
    return (await household.alarmReport()) as AlarmReport;
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
 * GET /alarms?cells=owner,second,household: each named cell's stored alarm against its earliest
 * stored timer, read without re-arming. `person` stands for every person cell. Like /health, it
 * reveals times only and is reachable only from the host (the release tool's curl).
 */
export async function alarms(url: URL, env: WorkerEnv): Promise<Response> {
  const requested = (url.searchParams.get("cells") ?? "person,household")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .flatMap((name) => (name === "person" ? PERSONS : [name]));
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

const CELL_ROUTE = /^\/v1\/cells\/([a-z][a-z0-9-]{0,31})\//;

/** Every route except the test cell's conformance and lab routes. */
export async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return health(url, (person) => cellStatus(env, person));
  }
  if (request.method === "GET" && url.pathname === "/alarms") return alarms(url, env);
  const person = CELL_ROUTE.exec(url.pathname)?.[1];
  if (person === undefined || !PERSONS.includes(person)) {
    return Response.json({ error: "not found" }, { status: 404 });
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
